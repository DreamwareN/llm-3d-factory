import { create } from 'zustand';
import { toast } from 'sonner';
import { isMutatingTool } from '@llm3d/shared/tool-names';
import type {
  ArtifactRecord,
  ClientToolRequest,
  ConversationRecord,
  ConversationStatus,
  MessageRecord,
  ProjectRecord,
  ProjectSceneMeta,
  ProviderProfileRecord,
  SceneOperation,
  ServerMessage,
  TimelineItem,
  UsageInfo,
} from '@llm3d/shared';
import { api, type ConversationUpdateInput } from '@/lib/api';
import { readLastModel, writeLastModel } from '@/lib/last-model';
import { ws } from '@/lib/ws';
import { sandbox } from '@/features/preview/sandbox-controller';

export interface ConversationRuntimeState {
  conversation: ConversationRecord;
  messages: MessageRecord[];
  timeline: TimelineItem[];
  usage: UsageInfo;
  pendingClientTools: ClientToolRequest[];
}

export interface ProjectRuntimeState {
  project: ProjectRecord;
  conversations: Record<string, ConversationRuntimeState>;
  operations: SceneOperation[];
  artifacts: ArtifactRecord[];
  scene: ProjectSceneMeta | null;
  previewStatus: 'idle' | 'loading' | 'ready' | 'error';
  previewError: string | null;
  snapshotAt: number;
}

interface AppState {
  connected: boolean;
  loading: boolean;
  projects: ProjectRecord[];
  providers: ProviderProfileRecord[];
  selectedProjectId: string | null;
  activeConversationId: string | null;
  projectStates: Record<string, ProjectRuntimeState>;
  error: string | null;

  bootstrap: () => Promise<void>;
  refreshProjects: () => Promise<void>;
  refreshProviders: () => Promise<void>;
  selectProject: (projectId: string | null) => void;
  selectConversation: (conversationId: string) => void;
  createProject: (name: string, description?: string) => Promise<void>;
  deleteProject: (projectId: string) => Promise<void>;
  createConversation: (
    projectId: string,
    input?: { title?: string; providerProfileId?: string; model?: string },
  ) => Promise<string | null>;
  updateConversation: (conversationId: string, input: ConversationUpdateInput) => Promise<boolean>;
  deleteConversation: (conversationId: string) => Promise<void>;
  pruneOperations: (projectId: string, ids: string[]) => Promise<boolean>;
  startConversation: (conversationId: string, prompt: string) => void;
  sendUserMessage: (conversationId: string, text: string) => void;
  cancelConversation: (conversationId: string) => void;
  markPreviewReady: (projectId: string) => void;
  applyEvent: (message: ServerMessage) => void;
  executeClientTool: (conversationId: string, request: ClientToolRequest) => Promise<void>;
}

const emptyConversationRuntime = (
  conversation: ConversationRecord,
): ConversationRuntimeState => ({
  conversation,
  messages: [],
  timeline: [],
  usage: {},
  pendingClientTools: [],
});

const emptyProjectRuntime = (project: ProjectRecord): ProjectRuntimeState => ({
  project,
  conversations: {},
  operations: [],
  artifacts: [],
  scene: null,
  previewStatus: 'idle',
  previewError: null,
  snapshotAt: 0,
});

// React StrictMode mounts effects twice in dev; without this guard the store
// would register duplicate WS/sandbox handlers and execute every client tool
// twice, corrupting the scene with phantom objects.
let bootstrapStarted = false;
const inFlightClientTools = new Set<string>();
const cancelledClientTools = new Set<string>();
const dirtyScenes = new Set<string>();
const pendingSceneSnapshots = new Set<string>();
let sceneSnapshotRunning = false;

export const useAppStore = create<AppState>()((set, get) => {
  const patchProject = (
    projectId: string,
    updater: (state: ProjectRuntimeState) => ProjectRuntimeState,
  ) => {
    set((state) => {
      const current = state.projectStates[projectId];
      if (!current) return state;
      return {
        projectStates: { ...state.projectStates, [projectId]: updater(current) },
      };
    });
  };

  const patchConversation = (
    conversationId: string,
    updater: (state: ConversationRuntimeState) => ConversationRuntimeState,
  ) => {
    set((state) => {
      for (const [projectId, project] of Object.entries(state.projectStates)) {
        const conversation = project.conversations[conversationId];
        if (!conversation) continue;
        return {
          projectStates: {
            ...state.projectStates,
            [projectId]: {
              ...project,
              conversations: {
                ...project.conversations,
                [conversationId]: updater(conversation),
              },
            },
          },
        };
      }
      return state;
    });
  };

  const upsertConversationRecord = (conversation: ConversationRecord) => {
    set((state) => {
      const project = state.projectStates[conversation.projectId];
      if (!project) return state;
      const existing = project.conversations[conversation.id];
      return {
        projectStates: {
          ...state.projectStates,
          [conversation.projectId]: {
            ...project,
            conversations: {
              ...project.conversations,
              [conversation.id]: existing
                ? { ...existing, conversation }
                : emptyConversationRuntime(conversation),
            },
          },
        },
      };
    });
  };

  const projectIdForConversation = (conversationId: string): string | null => {
    for (const [projectId, project] of Object.entries(get().projectStates)) {
      if (project.conversations[conversationId]) return projectId;
    }
    return null;
  };

  const snapshotScene = async (projectId: string): Promise<void> => {
    pendingSceneSnapshots.add(projectId);
    if (sceneSnapshotRunning) return;
    sceneSnapshotRunning = true;
    try {
      while (pendingSceneSnapshots.size > 0) {
        const next = pendingSceneSnapshots.values().next().value as string | undefined;
        if (!next) break;
        pendingSceneSnapshots.delete(next);
        if (sandbox.attachedProjectId !== next || !sandbox.isReady) continue;
        const result = await sandbox.exportGlb();
        ws.send({
          type: 'scene.snapshot',
          projectId: next,
          dataBase64: result.dataBase64,
          ...(result.lighting ? { lighting: result.lighting } : {}),
        });
      }
    } catch (error) {
      console.warn('[scene] snapshot failed:', error);
    } finally {
      sceneSnapshotRunning = false;
    }
  };

  const flushPendingClientTools = (projectId: string) => {
    const project = get().projectStates[projectId];
    if (!project) return;
    for (const conversation of Object.values(project.conversations)) {
      for (const request of conversation.pendingClientTools) {
        void get().executeClientTool(conversation.conversation.id, request);
      }
    }
  };

  const selectConversation = (conversationId: string) => {
    const state = get();
    set({ activeConversationId: conversationId });
    ws.send({ type: 'conversation.subscribe', conversationId });
    const project = state.projectStates[state.selectedProjectId ?? ''];
    if (project && !project.conversations[conversationId]) {
      void api.conversations
        .get(conversationId)
        .then((conversation) => {
          upsertConversationRecord(conversation);
        })
        .catch(() => undefined);
    }
  };

  const resolveNewConversationModel = (
    projectId: string,
    input?: { providerProfileId?: string; model?: string },
  ): { providerProfileId: string; model: string } | null => {
    const state = get();
    const providerExists = (id: string) => state.providers.some((entry) => entry.id === id);

    if (
      input?.providerProfileId &&
      input.model?.trim() &&
      providerExists(input.providerProfileId)
    ) {
      return { providerProfileId: input.providerProfileId, model: input.model.trim() };
    }

    const last = readLastModel();
    if (last && providerExists(last.providerProfileId)) return last;

    const recent = Object.values(state.projectStates[projectId]?.conversations ?? {}).sort(
      (a, b) => b.conversation.updatedAt - a.conversation.updatedAt,
    )[0];
    if (recent?.conversation.model && providerExists(recent.conversation.providerProfileId)) {
      return {
        providerProfileId: recent.conversation.providerProfileId,
        model: recent.conversation.model,
      };
    }

    const first = state.providers[0];
    if (first?.defaultModel.trim()) {
      return { providerProfileId: first.id, model: first.defaultModel.trim() };
    }
    return null;
  };

  return {
    connected: false,
    loading: false,
    projects: [],
    providers: [],
    selectedProjectId: null,
    activeConversationId: null,
    projectStates: {},
    error: null,

    async bootstrap() {
      if (bootstrapStarted) return;
      bootstrapStarted = true;
      set({ loading: true });
      try {
        const [projects, providers] = await Promise.all([
          api.projects.list(),
          api.providers.list(),
        ]);
        set({ projects, providers, loading: false, error: null });
        const selected = get().selectedProjectId ?? projects[0]?.id ?? null;
        if (selected) get().selectProject(selected);
      } catch (error) {
        bootstrapStarted = false;
        set({ loading: false, error: error instanceof Error ? error.message : String(error) });
      }

      ws.onMessage((message) => get().applyEvent(message));
      ws.onStatus((status) => {
        set({ connected: status === 'open' });
        if (status === 'open') {
          const state = get();
          for (const projectId of Object.keys(state.projectStates)) {
            ws.send({ type: 'project.subscribe', projectId });
          }
          for (const project of Object.values(state.projectStates)) {
            for (const conversationId of Object.keys(project.conversations)) {
              ws.send({ type: 'conversation.subscribe', conversationId });
            }
          }
          if (state.selectedProjectId && sandbox.isReady) {
            ws.send({ type: 'preview.ready', projectId: state.selectedProjectId });
          }
        }
      });
      sandbox.onEvent((message) => {
        const projectId = sandbox.attachedProjectId;
        if (!projectId) return;
        if (message.type === 'sceneUpdated') {
          patchProject(projectId, (current) => ({
            ...current,
            previewStatus: 'ready',
            previewError: null,
          }));
        }
        // Tool requests that arrived while the sandbox was reloading are kept
        // pending; replay them as soon as the runtime is alive again.
        if (message.type === 'ready' || message.type === 'sceneUpdated') {
          flushPendingClientTools(projectId);
        }
      });
      ws.connect();
    },

    async refreshProjects() {
      set({ projects: await api.projects.list() });
    },

    async refreshProviders() {
      set({ providers: await api.providers.list() });
    },

    selectProject(projectId) {
      if (projectId && projectId === get().selectedProjectId && get().projectStates[projectId]) {
        return;
      }
      const previous = get().selectedProjectId;
      if (previous && previous !== projectId) {
        ws.send({ type: 'preview.detach', projectId: previous });
      }
      set({ selectedProjectId: projectId, activeConversationId: null });
      if (!projectId) return;
      const project = get().projects.find((entry) => entry.id === projectId);
      if (project && !get().projectStates[projectId]) {
        set((state) => ({
          projectStates: { ...state.projectStates, [projectId]: emptyProjectRuntime(project) },
        }));
      }
      // Re-subscribing to an already subscribed project sends no snapshot, so
      // restore the conversation selection from the cached project state.
      const cached = Object.values(get().projectStates[projectId]?.conversations ?? {}).sort(
        (a, b) => b.conversation.updatedAt - a.conversation.updatedAt,
      );
      if (cached.length > 0) selectConversation(cached[0].conversation.id);
      ws.send({ type: 'project.subscribe', projectId });
    },

    selectConversation,

    async createProject(name, description) {
      const project = await api.projects.create({ name, description });
      set((state) => ({
        projects: [project, ...state.projects],
        projectStates: { ...state.projectStates, [project.id]: emptyProjectRuntime(project) },
      }));
      get().selectProject(project.id);
      toast.success(`项目「${project.name}」已创建`);
    },

    async deleteProject(projectId) {
      await api.projects.remove(projectId);
      set((state) => {
        const projectStates = { ...state.projectStates };
        delete projectStates[projectId];
        const projects = state.projects.filter((project) => project.id !== projectId);
        return {
          projects,
          projectStates,
          selectedProjectId: state.selectedProjectId === projectId ? null : state.selectedProjectId,
          activeConversationId:
            state.selectedProjectId === projectId ? null : state.activeConversationId,
        };
      });
      const next = get().projects[0]?.id ?? null;
      if (!get().selectedProjectId && next) get().selectProject(next);
    },

    async createConversation(projectId, input) {
      const resolved = resolveNewConversationModel(projectId, input);
      if (!resolved) {
        toast.error('请先在「设置」添加 Provider 并填写默认模型');
        return null;
      }
      try {
        const conversation = await api.projects.createConversation(projectId, {
          title: input?.title,
          providerProfileId: resolved.providerProfileId,
          model: resolved.model,
        });
        writeLastModel(resolved);
        if (get().selectedProjectId !== projectId) get().selectProject(projectId);
        upsertConversationRecord(conversation);
        selectConversation(conversation.id);
        return conversation.id;
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
        return null;
      }
    },

    async updateConversation(conversationId, input) {
      try {
        const conversation = await api.conversations.update(conversationId, input);
        if (input.providerProfileId || input.model) {
          writeLastModel({
            providerProfileId: conversation.providerProfileId,
            model: conversation.model,
          });
        }
        upsertConversationRecord(conversation);
        return true;
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
        return false;
      }
    },

    async pruneOperations(projectId, ids) {
      try {
        const result = await api.projects.pruneOperations(projectId, ids);
        patchProject(projectId, (current) => ({ ...current, operations: result.operations }));
        return true;
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
        return false;
      }
    },

    async deleteConversation(conversationId) {
      await api.conversations.remove(conversationId);
      set((state) => {
        const projectStates = { ...state.projectStates };
        for (const [projectId, project] of Object.entries(projectStates)) {
          if (!project.conversations[conversationId]) continue;
          const conversations = { ...project.conversations };
          delete conversations[conversationId];
          projectStates[projectId] = { ...project, conversations };
        }
        return {
          projectStates,
          activeConversationId:
            state.activeConversationId === conversationId ? null : state.activeConversationId,
        };
      });
    },

    startConversation(conversationId, prompt) {
      ws.send({ type: 'conversation.start', conversationId, prompt });
      patchConversation(conversationId, (current) => ({
        ...current,
        conversation: { ...current.conversation, status: 'running' },
      }));
    },

    sendUserMessage(conversationId, text) {
      ws.send({ type: 'conversation.user_message', conversationId, text });
    },

    cancelConversation(conversationId) {
      ws.send({ type: 'conversation.cancel', conversationId });
    },

    markPreviewReady(projectId) {
      ws.send({ type: 'preview.ready', projectId });
    },

    applyEvent(message) {
      switch (message.type) {
        case 'project.snapshot': {
          const snapshot = message.snapshot;
          const existing = get().projectStates[message.projectId];
          const conversations: Record<string, ConversationRuntimeState> = {};
          for (const conversation of snapshot.conversations) {
            conversations[conversation.id] = existing?.conversations[conversation.id]
              ? { ...existing.conversations[conversation.id], conversation }
              : emptyConversationRuntime(conversation);
          }
          set((state) => ({
            projectStates: {
              ...state.projectStates,
              [message.projectId]: {
                project: snapshot.project,
                conversations,
                operations: snapshot.operations,
                artifacts: snapshot.artifacts,
                scene: snapshot.scene,
                previewStatus: existing?.previewStatus ?? 'idle',
                previewError: existing?.previewError ?? null,
                snapshotAt: Date.now(),
              },
            },
            projects: state.projects.some((entry) => entry.id === snapshot.project.id)
              ? state.projects.map((entry) =>
                  entry.id === snapshot.project.id ? snapshot.project : entry,
                )
              : [snapshot.project, ...state.projects],
          }));
          const state = get();
          if (
            state.selectedProjectId === message.projectId &&
            !state.activeConversationId &&
            snapshot.conversations.length > 0
          ) {
            selectConversation(snapshot.conversations[0].id);
          }
          break;
        }
        case 'conversation.snapshot': {
          const snapshot = message.snapshot;
          const runtime: ConversationRuntimeState = {
            conversation: snapshot.conversation,
            messages: snapshot.messages,
            timeline: snapshot.timeline,
            usage: snapshot.usage,
            pendingClientTools: snapshot.pendingClientTools,
          };
          set((state) => {
            const project = state.projectStates[snapshot.conversation.projectId];
            if (!project) return state;
            return {
              projectStates: {
                ...state.projectStates,
                [snapshot.conversation.projectId]: {
                  ...project,
                  conversations: {
                    ...project.conversations,
                    [snapshot.conversation.id]: runtime,
                  },
                },
              },
            };
          });
          if (
            runtime.pendingClientTools.length > 0 &&
            sandbox.isReady &&
            sandbox.attachedProjectId === snapshot.conversation.projectId
          ) {
            for (const request of runtime.pendingClientTools) {
              void get().executeClientTool(message.conversationId, request);
            }
          }
          break;
        }
        case 'conversation.status': {
          patchConversation(message.conversationId, (current) => ({
            ...current,
            conversation: {
              ...current.conversation,
              status: message.status,
              error: message.error ?? null,
            },
          }));
          break;
        }
        case 'conversation.updated': {
          upsertConversationRecord(message.conversation);
          break;
        }
        case 'conversation.error': {
          toast.error(message.message);
          break;
        }
        case 'conversation.turn_finished': {
          if (message.status === 'failed') {
            const conversation = get().projectStates[message.projectId]?.conversations[
              message.conversationId
            ]?.conversation;
            toast.error(`「${conversation?.title ?? '对话'}」生成失败`);
          }
          if (dirtyScenes.delete(message.projectId)) {
            void snapshotScene(message.projectId);
          }
          break;
        }
        case 'message.added': {
          patchConversation(message.conversationId, (current) => {
            if (current.messages.some((entry) => entry.id === message.message.id)) return current;
            return { ...current, messages: [...current.messages, message.message] };
          });
          break;
        }
        case 'message.updated': {
          patchConversation(message.conversationId, (current) => ({
            ...current,
            messages: current.messages.map((entry) =>
              entry.id === message.message.id ? message.message : entry,
            ),
          }));
          break;
        }
        case 'message.delta': {
          patchConversation(message.conversationId, (current) => ({
            ...current,
            messages: current.messages.map((entry) => {
              if (entry.id !== message.messageId) return entry;
              const parts = [...entry.parts];
              const last = parts[parts.length - 1];
              if (last && last.type === message.part) {
                parts[parts.length - 1] = { ...last, text: last.text + message.delta };
              } else {
                parts.push({ type: message.part, text: message.delta });
              }
              return { ...entry, parts };
            }),
          }));
          break;
        }
        case 'timeline.added': {
          patchConversation(message.conversationId, (current) => {
            if (current.timeline.some((entry) => entry.id === message.item.id)) return current;
            return { ...current, timeline: [...current.timeline, message.item] };
          });
          break;
        }
        case 'timeline.updated': {
          patchConversation(message.conversationId, (current) => ({
            ...current,
            timeline: current.timeline.map((entry) =>
              entry.id === message.item.id ? message.item : entry,
            ),
          }));
          break;
        }
        case 'scene.operation': {
          patchProject(message.projectId, (current) => {
            if (current.operations.some((entry) => entry.id === message.operation.id)) {
              return current;
            }
            return { ...current, operations: [...current.operations, message.operation] };
          });
          break;
        }
        case 'scene.operations_pruned': {
          patchProject(message.projectId, (current) => ({
            ...current,
            operations: current.operations.filter((entry) => !message.ids.includes(entry.id)),
          }));
          break;
        }
        case 'scene.updated': {
          patchProject(message.projectId, (current) => ({
            ...current,
            scene: message.scene,
          }));
          break;
        }
        case 'artifact.created': {
          patchProject(message.projectId, (current) => ({
            ...current,
            artifacts: [message.artifact, ...current.artifacts],
          }));
          break;
        }
        case 'usage': {
          patchConversation(message.conversationId, (current) => ({
            ...current,
            usage: message.usage,
          }));
          break;
        }
        case 'tool.client_request': {
          patchConversation(message.conversationId, (current) => {
            if (
              current.pendingClientTools.some(
                (entry) => entry.requestId === message.request.requestId,
              )
            ) {
              return current;
            }
            return {
              ...current,
              pendingClientTools: [...current.pendingClientTools, message.request],
            };
          });
          if (
            sandbox.isReady &&
            sandbox.attachedProjectId === projectIdForConversation(message.conversationId)
          ) {
            void get().executeClientTool(message.conversationId, message.request);
          } else {
            // Keep the server from timing out while the preview re-attaches;
            // the request stays pending and is flushed when the sandbox is ready.
            ws.send({
              type: 'client.tool_ack',
              conversationId: message.conversationId,
              requestId: message.request.requestId,
            });
          }
          break;
        }
        case 'tool.cancel': {
          cancelledClientTools.add(message.requestId);
          if (cancelledClientTools.size > 500) cancelledClientTools.clear();
          patchConversation(message.conversationId, (current) => ({
            ...current,
            pendingClientTools: current.pendingClientTools.filter(
              (entry) => entry.requestId !== message.requestId,
            ),
          }));
          break;
        }
        case 'error': {
          toast.error(message.message);
          break;
        }
        case 'log':
        case 'pong':
        default:
          break;
      }
    },

    async executeClientTool(conversationId, request) {
      if (cancelledClientTools.delete(request.requestId)) return;
      if (inFlightClientTools.has(request.requestId)) return;
      inFlightClientTools.add(request.requestId);
      ws.send({ type: 'client.tool_ack', conversationId, requestId: request.requestId });
      try {
        const result = await sandbox.executeTool(request.name, request.input);
        if (result.success !== false && isMutatingTool(request.name)) {
          dirtyScenes.add(request.projectId);
        }
        ws.send({
          type: 'client.tool_result',
          conversationId,
          requestId: request.requestId,
          ok: true,
          result,
        });
      } catch (error) {
        ws.send({
          type: 'client.tool_result',
          conversationId,
          requestId: request.requestId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        inFlightClientTools.delete(request.requestId);
        patchConversation(conversationId, (current) => ({
          ...current,
          pendingClientTools: current.pendingClientTools.filter(
            (entry) => entry.requestId !== request.requestId,
          ),
        }));
      }
    },
  };
});

export function isGenerating(status: ConversationStatus): boolean {
  return status === 'running';
}
