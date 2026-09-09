import type { ConversationConfig, ConversationRecord } from '@llm3d/shared';
import type { ServerConfig } from '../config.js';
import type { Repositories } from '../db/repositories.js';
import { ProjectHub } from '../project/project-hub.js';
import { ConversationSession } from './conversation-session.js';

export interface SessionManagerDeps {
  repos: Repositories;
  config: ServerConfig;
}

export interface CreateConversationManagerInput {
  projectId: string;
  title: string;
  providerProfileId: string;
  model: string;
  config?: Partial<ConversationConfig>;
}

export type TurnInput = { prompt: string; text?: never } | { prompt?: never; text: string };

/**
 * Owns the live conversation sessions and per-project scene hubs. Enforces the
 * "one generating conversation per project" rule.
 */
export class SessionManager {
  private readonly sessions = new Map<string, ConversationSession>();
  private readonly hubs = new Map<string, ProjectHub>();
  private readonly sceneLocks = new Map<string, string>();

  constructor(private readonly deps: SessionManagerDeps) {}

  getHub(projectId: string): ProjectHub | undefined {
    if (!this.deps.repos.projects.get(projectId)) return undefined;
    return this.requireHub(projectId);
  }

  create(input: CreateConversationManagerInput): ConversationSession {
    const record = this.deps.repos.conversations.create({
      projectId: input.projectId,
      title: input.title,
      providerProfileId: input.providerProfileId,
      model: input.model,
      config: {
        maxSteps: input.config?.maxSteps ?? this.deps.config.defaultMaxSteps,
        temperature: input.config?.temperature ?? 0.4,
        maxOutputTokens: input.config?.maxOutputTokens,
        systemPromptExtra: input.config?.systemPromptExtra,
      },
    });
    return this.instantiate(record);
  }

  getOrLoad(conversationId: string): ConversationSession | undefined {
    const existing = this.sessions.get(conversationId);
    if (existing) return existing;
    const record = this.deps.repos.conversations.get(conversationId);
    if (!record) return undefined;
    return this.instantiate(record);
  }

  getOrLoadOrThrow(conversationId: string): ConversationSession {
    const session = this.getOrLoad(conversationId);
    if (!session) throw new Error(`Conversation ${conversationId} not found.`);
    return session;
  }

  activeConversationId(projectId: string): string | null {
    return this.sceneLocks.get(projectId) ?? null;
  }

  remove(conversationId: string): void {
    const session = this.sessions.get(conversationId);
    session?.cancel();
    this.sessions.delete(conversationId);
    this.deps.repos.conversations.remove(conversationId);
  }

  removeProject(projectId: string): void {
    for (const [conversationId, session] of this.sessions) {
      if (session.projectId !== projectId) continue;
      session.cancel();
      this.sessions.delete(conversationId);
    }
    this.hubs.delete(projectId);
    this.sceneLocks.delete(projectId);
    this.deps.repos.projects.remove(projectId);
  }

  async runTurn(conversationId: string, input: TurnInput): Promise<void> {
    const session = this.getOrLoadOrThrow(conversationId);
    const holder = this.sceneLocks.get(session.projectId);
    if (holder && holder !== conversationId) {
      throw new Error('该项目的场景正被另一个对话占用，请等待当前对话完成后再发送。');
    }
    this.sceneLocks.set(session.projectId, conversationId);
    try {
      if (input.prompt !== undefined) await session.start(input.prompt);
      else await session.sendUserMessage(input.text);
    } finally {
      if (this.sceneLocks.get(session.projectId) === conversationId) {
        this.sceneLocks.delete(session.projectId);
      }
    }
  }

  private requireHub(projectId: string): ProjectHub {
    let hub = this.hubs.get(projectId);
    if (!hub) {
      hub = new ProjectHub(projectId, this.deps);
      this.hubs.set(projectId, hub);
    }
    return hub;
  }

  private instantiate(record: ConversationRecord): ConversationSession {
    const session = new ConversationSession(
      { ...this.deps, hub: this.requireHub(record.projectId) },
      record,
    );
    this.sessions.set(record.id, session);
    return session;
  }
}
