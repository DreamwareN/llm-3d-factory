import { randomUUID } from 'node:crypto';
import {
  hasToolCall,
  isStepCount,
  streamText,
  type LanguageModelUsage,
  type ModelMessage,
  type ToolSet,
} from 'ai';
import {
  DEFAULT_CONVERSATION_TITLE,
  type ArtifactRecord,
  type ClientToolName,
  type ClientToolRequest,
  type ConversationRecord,
  type ConversationSnapshot,
  type ConversationStatus,
  type MessagePart,
  type MessageRecord,
  type SceneOperation,
  type TimelineItem,
  type ToolExecutionResult,
  type UsageInfo,
} from '@llm3d/shared';
import type { ServerConfig } from '../config.js';
import type { Repositories } from '../db/repositories.js';
import { providerRegistry } from '../llm/provider-registry.js';
import type { ProjectHub } from '../project/project-hub.js';
import { buildTools, type ToolHost } from '../tools/index.js';
import type { ServerEvent } from './events.js';
import { buildSystemPrompt } from './system-prompt.js';

export interface ConversationSessionDeps {
  repos: Repositories;
  config: ServerConfig;
  hub: ProjectHub;
}

interface PendingClientTool {
  request: ClientToolRequest;
  resolve: (value: ToolExecutionResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout | null;
}

interface ActiveAssistant {
  id: string;
  parts: MessagePart[];
}

function appendDelta(parts: MessagePart[], type: 'text' | 'reasoning', delta: string): void {
  const last = parts[parts.length - 1];
  if (last && last.type === type) {
    last.text += delta;
  } else {
    parts.push({ type, text: delta });
  }
}

function toUsageInfo(usage: LanguageModelUsage): UsageInfo {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    reasoningTokens: usage.outputTokenDetails?.reasoningTokens,
    cachedInputTokens: usage.inputTokenDetails?.cacheReadTokens,
  };
}

/**
 * One conversation inside a project. Drives the AI SDK loop and owns
 * conversation-scoped state (messages, timeline, usage, pending client tools).
 * Scene-scoped writes are delegated to the shared ProjectHub.
 */
export class ConversationSession implements ToolHost {
  readonly id: string;
  readonly projectId: string;

  private record: ConversationRecord;
  private readonly messages: MessageRecord[];
  private modelMessages: ModelMessage[];
  private timeline: TimelineItem[];
  private usage: UsageInfo;

  private readonly listeners = new Set<(event: ServerEvent) => void>();
  private readonly pending = new Map<string, PendingClientTool>();
  private abortController: AbortController | null = null;
  private activeAssistant: ActiveAssistant | null = null;
  private running = false;
  private saveTimer: NodeJS.Timeout | null = null;
  private lastProviderProfileId: string | null = null;

  constructor(
    private readonly deps: ConversationSessionDeps,
    record: ConversationRecord,
  ) {
    this.id = record.id;
    this.projectId = record.projectId;
    this.record = record;
    this.messages = deps.repos.messages.list(record.id);
    const state = deps.repos.conversationState.get(record.id);
    this.modelMessages = (state?.modelMessages ?? []) as ModelMessage[];
    this.timeline = state?.timeline ?? [];
    this.usage = state?.usage ?? {};
    if (record.status === 'running') {
      this.record = { ...record, status: 'idle' };
      deps.repos.conversations.update(record.id, { status: 'idle' });
    }
  }

  get conversationId(): string {
    return this.id;
  }

  get status(): ConversationStatus {
    return this.record.status;
  }

  get isRunning(): boolean {
    return this.running;
  }

  get title(): string {
    return this.record.title;
  }

  get conversation(): ConversationRecord {
    return this.record;
  }

  subscribe(listener: (event: ServerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  isPreviewAttached(): boolean {
    return this.deps.hub.isPreviewAttached();
  }

  requirePreview(): void {
    this.deps.hub.requirePreview();
  }

  getSnapshot(): ConversationSnapshot {
    return {
      conversation: this.record,
      messages: this.messages.map((message) => ({ ...message })),
      timeline: this.timeline.map((item) => ({ ...item })),
      usage: this.usage,
      pendingClientTools: [...this.pending.values()].map((entry) => entry.request),
    };
  }

  async start(prompt: string): Promise<void> {
    if (this.running) throw new Error('This conversation is already generating.');
    this.appendUserMessage(prompt);
    await this.runLoop();
  }

  async sendUserMessage(text: string): Promise<void> {
    if (this.running) throw new Error('This conversation is already generating.');
    this.appendUserMessage(text);
    await this.runLoop();
  }

  cancel(): void {
    if (!this.abortController) return;
    this.abortController.abort(new Error('Cancelled by user'));
    this.rejectAllPending('Cancelled by user.', true);
  }

  update(input: {
    title?: string;
    providerProfileId?: string;
    model?: string;
    resetContext?: boolean;
  }): ConversationRecord {
    if (this.running) throw new Error('对话正在生成中，无法修改。');
    const switchingModel =
      (input.providerProfileId !== undefined &&
        input.providerProfileId !== this.record.providerProfileId) ||
      (input.model !== undefined && input.model !== this.record.model);
    const previous = `${this.record.providerProfileId}::${this.record.model}`;
    const updated = this.deps.repos.conversations.update(this.id, {
      title: input.title,
      providerProfileId: input.providerProfileId,
      model: input.model,
      ...(switchingModel ? { error: null, status: this.record.status === 'failed' ? 'idle' : this.record.status } : {}),
    });
    if (!updated) throw new Error(`Conversation ${this.id} not found.`);
    this.record = updated;
    if (switchingModel && input.resetContext) {
      this.modelMessages = [];
      this.deps.repos.conversationState.clearMessages(this.id);
    }
    this.emit({
      type: 'conversation.updated',
      projectId: this.projectId,
      conversationId: this.id,
      conversation: updated,
    });
    if (switchingModel) {
      this.addTimeline({
        id: randomUUID(),
        kind: 'status',
        title: input.resetContext ? '已切换模型（上下文已重置）' : '已切换模型（保留上下文）',
        detail: `${previous} → ${updated.providerProfileId}::${updated.model}`,
        status: 'done',
        startedAt: Date.now(),
        endedAt: Date.now(),
      });
    }
    this.persistState();
    return updated;
  }

  handleClientToolResult(
    requestId: string,
    ok: boolean,
    result?: unknown,
    error?: string,
  ): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    this.pending.delete(requestId);
    if (ok) {
      entry.resolve((result ?? { success: true }) as ToolExecutionResult);
    } else {
      entry.reject(new Error(error ?? `Client tool "${entry.request.name}" failed.`));
    }
    this.schedulePersist();
  }

  /**
   * The browser acknowledges a client tool request as soon as it receives it,
   * even if the preview sandbox is not ready to execute yet. Re-arm the timeout
   * so a slow-but-alive client is not mistaken for a disconnected one.
   */
  ackClientTool(requestId: string): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    this.armTimeout(entry);
  }

  // ---- ToolHost implementation -------------------------------------------------

  requestClientTool(
    name: ClientToolName,
    input: unknown,
    toolCallId: string,
  ): Promise<ToolExecutionResult> {
    this.requirePreview();
    const request: ClientToolRequest = {
      requestId: randomUUID(),
      callId: toolCallId,
      projectId: this.projectId,
      conversationId: this.id,
      name,
      input,
      timeoutMs: this.deps.config.clientToolTimeoutMs,
      createdAt: Date.now(),
    };
    this.emit({
      type: 'tool.client_request',
      projectId: this.projectId,
      conversationId: this.id,
      request,
    });
    return new Promise((resolve, reject) => {
      const entry: PendingClientTool = { request, resolve, reject, timer: null };
      this.pending.set(request.requestId, entry);
      this.armTimeout(entry);
      this.schedulePersist();
    });
  }

  private armTimeout(entry: PendingClientTool): void {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      this.pending.delete(entry.request.requestId);
      // Tell the browser to drop the request so a late execution cannot mutate
      // the scene without a matching operation record.
      this.emit({
        type: 'tool.cancel',
        projectId: this.projectId,
        conversationId: this.id,
        requestId: entry.request.requestId,
      });
      entry.reject(
        new Error(
          `Client tool "${entry.request.name}" timed out after ${entry.request.timeoutMs}ms. ` +
            'The preview renderer may be busy or disconnected.',
        ),
      );
    }, entry.request.timeoutMs);
  }

  recordOperation(tool: string, input: unknown, result: ToolExecutionResult): SceneOperation {
    const operation = this.deps.hub.recordOperation(this.id, tool, input, result);
    this.addTimeline({
      id: randomUUID(),
      kind: 'scene',
      title: `场景操作 #${operation.seq} · ${tool}`,
      detail: result.message ?? result.object_id ?? '',
      status: 'done',
      startedAt: Date.now(),
      endedAt: Date.now(),
      meta: { tool, operationId: operation.id },
    });
    return operation;
  }

  saveArtifact(input: {
    kind: ArtifactRecord['kind'];
    filename: string;
    mime: string;
    data: Buffer;
    meta?: Record<string, unknown>;
  }): ArtifactRecord {
    const artifact = this.deps.hub.saveArtifact(this.id, input);
    this.addTimeline({
      id: randomUUID(),
      kind: 'artifact',
      title: `产物: ${artifact.filename}`,
      detail: `${artifact.kind.toUpperCase()} · ${(artifact.size / 1024).toFixed(1)} KB`,
      status: 'done',
      startedAt: Date.now(),
      endedAt: Date.now(),
      meta: { artifactId: artifact.id, kind: artifact.kind },
    });
    return artifact;
  }

  toolStarted(callId: string, name: string, input: unknown): void {
    const message = this.ensureAssistantMessage();
    message.parts.push({
      type: 'tool-call',
      callId,
      name,
      input,
      state: 'running',
      startedAt: Date.now(),
    });
    this.addTimeline({
      id: `tool:${callId}`,
      kind: 'tool',
      title: name,
      detail: summarizeInput(input),
      status: 'running',
      startedAt: Date.now(),
      meta: { callId, toolName: name },
    });
    this.persistMessage(message);
    // Push the running tool call to the chat immediately; otherwise the card
    // only appears at finish-step, making a slow tool look like it timed out
    // the instant it showed up.
    this.emitMessageUpdated(message.id);
  }

  toolFinished(callId: string, ok: boolean, result?: unknown, error?: string): void {
    const message = this.activeAssistant;
    if (message) {
      const part = message.parts.find(
        (item): item is Extract<MessagePart, { type: 'tool-call' }> =>
          item.type === 'tool-call' && item.callId === callId,
      );
      if (part) {
        part.state = ok ? 'done' : 'error';
        part.result = result;
        part.error = error;
        part.endedAt = Date.now();
      }
      this.persistMessage(message);
      this.emitMessageUpdated(message.id);
    }
    const toolResult = result as ToolExecutionResult | undefined;
    this.updateTimeline(`tool:${callId}`, {
      status: ok && toolResult?.success !== false ? 'done' : 'error',
      endedAt: Date.now(),
      detail: ok
        ? (toolResult?.message ?? summarizeResult(result))
        : (error ?? toolResult?.error),
    });
  }

  finishTurn(summary: string): void {
    this.addTimeline({
      id: randomUUID(),
      kind: 'status',
      title: '模型完成',
      detail: summary,
      status: 'done',
      startedAt: Date.now(),
      endedAt: Date.now(),
    });
    this.schedulePersist();
  }

  // ---- Internals ---------------------------------------------------------------

  private maybeAutoTitle(text: string): void {
    if (this.record.title !== DEFAULT_CONVERSATION_TITLE) return;
    const title = text.replace(/\s+/g, ' ').trim().slice(0, 24);
    if (!title) return;
    const updated = this.deps.repos.conversations.update(this.id, { title });
    if (!updated) return;
    this.record = updated;
    this.emit({
      type: 'conversation.updated',
      projectId: this.projectId,
      conversationId: this.id,
      conversation: updated,
    });
  }

  private appendUserMessage(text: string): void {
    const isFirstUserMessage = !this.messages.some((message) => message.role === 'user');
    const message = this.deps.repos.messages.create({
      conversationId: this.id,
      role: 'user',
      parts: [{ type: 'text', text }],
    });
    this.messages.push(message);
    this.modelMessages.push({ role: 'user', content: text });
    if (isFirstUserMessage) this.maybeAutoTitle(text);
    this.emit({ type: 'message.added', conversationId: this.id, message });
    this.addTimeline({
      id: randomUUID(),
      kind: 'status',
      title: '用户消息',
      detail: text.length > 160 ? `${text.slice(0, 160)}…` : text,
      status: 'done',
      startedAt: Date.now(),
      endedAt: Date.now(),
    });
    this.persistState();
  }

  private prepareModelMessages(providerChanged: boolean): ModelMessage[] {
    if (!providerChanged) return this.modelMessages;
    return this.modelMessages.map((message) => {
      if (typeof message.content === 'string') return message;
      const content = (message.content as Array<{ type: string }>).filter(
        (part) => part.type !== 'reasoning',
      );
      return { ...message, content } as ModelMessage;
    });
  }

  private async runLoop(): Promise<void> {
    this.running = true;
    this.abortController = new AbortController();
    this.activeAssistant = null;

    const runStart = Date.now();
    let stepIndex = 0;
    let currentStepId: string | null = null;
    let failed = false;

    try {
      const profile = this.deps.repos.providers.getWithSecret(this.record.providerProfileId);
      if (!profile) throw new Error('Provider profile no longer exists.');
      if (!this.record.model) throw new Error('No model selected for this conversation.');

      const model = providerRegistry.getModel(
        {
          id: profile.id,
          name: profile.name,
          baseUrl: profile.baseUrl,
          apiKey: profile.apiKey,
          headers: profile.headers,
          defaultModel: profile.defaultModel,
        },
        this.record.model,
      );

      const providerChanged =
        this.lastProviderProfileId !== null &&
        this.lastProviderProfileId !== this.record.providerProfileId;

      const tools: ToolSet = buildTools(this);
      const result = streamText({
        model,
        system: buildSystemPrompt({
          conversationTitle: this.record.title,
          hasPreview: this.isPreviewAttached(),
          maxSteps: this.record.config.maxSteps,
        }),
        messages: this.prepareModelMessages(providerChanged),
        tools,
        stopWhen: [isStepCount(this.record.config.maxSteps), hasToolCall('finish')],
        abortSignal: this.abortController.signal,
        temperature: this.record.config.temperature,
        maxOutputTokens: this.record.config.maxOutputTokens,
      });

      this.setStatus('running');

      for await (const part of result.fullStream) {
        switch (part.type) {
          case 'start-step': {
            stepIndex += 1;
            currentStepId = randomUUID();
            this.activeAssistant = null;
            this.addTimeline({
              id: currentStepId,
              kind: 'step',
              title: `Step ${stepIndex}`,
              status: 'running',
              startedAt: Date.now(),
            });
            break;
          }
          case 'text-delta': {
            const message = this.ensureAssistantMessage();
            appendDelta(message.parts, 'text', part.text);
            this.emit({
              type: 'message.delta',
              conversationId: this.id,
              messageId: message.id,
              part: 'text',
              delta: part.text,
            });
            break;
          }
          case 'reasoning-delta': {
            const message = this.ensureAssistantMessage();
            appendDelta(message.parts, 'reasoning', part.text);
            this.emit({
              type: 'message.delta',
              conversationId: this.id,
              messageId: message.id,
              part: 'reasoning',
              delta: part.text,
            });
            break;
          }
          case 'finish-step': {
            this.accumulateUsage(part.usage);
            if (currentStepId) {
              this.updateTimeline(currentStepId, {
                status: 'done',
                endedAt: Date.now(),
                meta: { usage: toUsageInfo(part.usage) },
              });
            }
            this.finalizeAssistantMessage();
            break;
          }
          case 'error': {
            throw part.error instanceof Error ? part.error : new Error(String(part.error));
          }
          default:
            break;
        }
      }

      const responseMessages = await result.responseMessages;
      this.modelMessages.push(...responseMessages);
      this.lastProviderProfileId = this.record.providerProfileId;
    } catch (error) {
      const aborted = this.abortController?.signal.aborted === true;
      const message = error instanceof Error ? error.message : String(error);
      if (aborted) {
        this.setStatus('idle');
      } else {
        failed = true;
        this.setStatus('failed', message);
        this.emit({
          type: 'conversation.error',
          projectId: this.projectId,
          conversationId: this.id,
          message,
        });
        this.addTimeline({
          id: randomUUID(),
          kind: 'error',
          title: '运行失败',
          detail: message,
          status: 'error',
          startedAt: Date.now(),
          endedAt: Date.now(),
        });
      }
    } finally {
      this.rejectAllPending('Run finished before the preview responded.');
      this.finalizeAssistantMessage();
      this.running = false;
      this.abortController = null;
      if (!failed && this.record.status !== 'failed') {
        this.setStatus('idle');
      }
      this.emit({
        type: 'conversation.turn_finished',
        projectId: this.projectId,
        conversationId: this.id,
        status: this.record.status,
      });
      this.addTimeline({
        id: randomUUID(),
        kind: 'status',
        title: '运行结束',
        detail: `${((Date.now() - runStart) / 1000).toFixed(1)}s · ${this.record.status}`,
        status: this.record.status === 'failed' ? 'error' : 'done',
        startedAt: Date.now(),
        endedAt: Date.now(),
      });
      this.persistState();
    }
  }

  private ensureAssistantMessage(): ActiveAssistant {
    if (this.activeAssistant) return this.activeAssistant;
    const record = this.deps.repos.messages.create({
      conversationId: this.id,
      role: 'assistant',
      parts: [],
    });
    this.messages.push(record);
    this.activeAssistant = { id: record.id, parts: record.parts };
    this.emit({ type: 'message.added', conversationId: this.id, message: record });
    return this.activeAssistant;
  }

  private finalizeAssistantMessage(): void {
    if (!this.activeAssistant) return;
    this.persistMessage(this.activeAssistant);
    this.emitMessageUpdated(this.activeAssistant.id);
    this.activeAssistant = null;
  }

  private persistMessage(active: ActiveAssistant): void {
    const stored = this.messages.find((message) => message.id === active.id);
    if (!stored) return;
    stored.parts = active.parts;
    this.deps.repos.messages.updateParts(active.id, active.parts);
    this.schedulePersist();
  }

  private emitMessageUpdated(messageId: string): void {
    const stored = this.messages.find((message) => message.id === messageId);
    if (!stored) return;
    this.emit({ type: 'message.updated', conversationId: this.id, message: { ...stored } });
  }

  private accumulateUsage(usage: LanguageModelUsage): void {
    const next = toUsageInfo(usage);
    this.usage = {
      inputTokens: (this.usage.inputTokens ?? 0) + (next.inputTokens ?? 0),
      outputTokens: (this.usage.outputTokens ?? 0) + (next.outputTokens ?? 0),
      totalTokens: (this.usage.totalTokens ?? 0) + (next.totalTokens ?? 0),
      reasoningTokens: (this.usage.reasoningTokens ?? 0) + (next.reasoningTokens ?? 0),
      cachedInputTokens: (this.usage.cachedInputTokens ?? 0) + (next.cachedInputTokens ?? 0),
    };
    this.emit({ type: 'usage', conversationId: this.id, usage: this.usage });
  }

  private setStatus(status: ConversationStatus, error?: string): void {
    this.record = { ...this.record, status, error: error ?? null, updatedAt: Date.now() };
    this.deps.repos.conversations.update(this.id, { status, error: error ?? null });
    this.emit({
      type: 'conversation.status',
      projectId: this.projectId,
      conversationId: this.id,
      status,
      error: error ?? null,
    });
  }

  private addTimeline(item: TimelineItem): void {
    this.timeline.push(item);
    this.emit({ type: 'timeline.added', conversationId: this.id, item });
    this.schedulePersist();
  }

  private updateTimeline(id: string, patch: Partial<TimelineItem>): void {
    const item = this.timeline.find((entry) => entry.id === id);
    if (!item) return;
    Object.assign(item, patch);
    this.emit({ type: 'timeline.updated', conversationId: this.id, item: { ...item } });
    this.schedulePersist();
  }

  private emit(event: ServerEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // listeners must never break a run
      }
    }
  }

  private rejectAllPending(reason: string, notifyClient = false): void {
    for (const entry of this.pending.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      if (notifyClient) {
        this.emit({
          type: 'tool.cancel',
          projectId: this.projectId,
          conversationId: this.id,
          requestId: entry.request.requestId,
        });
      }
      entry.reject(new Error(reason));
    }
    this.pending.clear();
  }

  private schedulePersist(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.persistState();
    }, 400);
  }

  private persistState(): void {
    this.deps.repos.conversationState.save(this.id, {
      modelMessages: this.modelMessages as unknown[],
      timeline: this.timeline,
      usage: this.usage,
    });
  }
}

function summarizeInput(input: unknown): string {
  if (input === null || typeof input !== 'object') return String(input ?? '');
  const record = input as Record<string, unknown>;
  const parts: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === 'string') {
      parts.push(`${key}: ${value.length > 60 ? `${value.slice(0, 60)}…` : value}`);
    } else {
      parts.push(`${key}: ${JSON.stringify(value)?.slice(0, 60)}`);
    }
    if (parts.length >= 4) break;
  }
  return parts.join(' · ');
}

function summarizeResult(result: unknown): string {
  if (result === null || result === undefined) return 'ok';
  const text = JSON.stringify(result);
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}
