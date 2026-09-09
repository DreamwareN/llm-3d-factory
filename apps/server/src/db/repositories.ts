import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type {
  ArtifactKind,
  ArtifactRecord,
  ConversationConfig,
  ConversationRecord,
  ConversationStatus,
  MessagePart,
  MessageRecord,
  MessageRole,
  ProjectRecord,
  ProjectSceneMeta,
  ProviderProfileRecord,
  SceneOperation,
  SetupLightingInput,
  TimelineItem,
  ToolExecutionResult,
  UsageInfo,
} from '@llm3d/shared';
import type { Db } from './client.js';
import {
  artifacts,
  conversationState,
  conversations,
  messages,
  projects,
  projectScenes,
  providerProfiles,
  sceneOperations,
} from './schema.js';

export interface CreateProviderInput {
  name: string;
  baseUrl: string;
  apiKey?: string;
  defaultModel?: string;
  headers?: Record<string, string>;
}

export interface UpdateProviderInput {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  defaultModel?: string;
  headers?: Record<string, string>;
}

export interface CreateConversationInput {
  projectId: string;
  title: string;
  providerProfileId: string;
  model: string;
  config: ConversationConfig;
}

export function createRepositories(db: Db) {
  const projectsRepo = {
    list(): ProjectRecord[] {
      return db.select().from(projects).orderBy(desc(projects.updatedAt)).all();
    },
    get(id: string): ProjectRecord | undefined {
      return db.select().from(projects).where(eq(projects.id, id)).get();
    },
    create(input: { name: string; description?: string }): ProjectRecord {
      const now = Date.now();
      const record: ProjectRecord = {
        id: randomUUID(),
        name: input.name,
        description: input.description ?? '',
        createdAt: now,
        updatedAt: now,
      };
      db.insert(projects).values(record).run();
      return record;
    },
    update(
      id: string,
      patch: { name?: string; description?: string },
    ): ProjectRecord | undefined {
      const current = projectsRepo.get(id);
      if (!current) return undefined;
      const next: ProjectRecord = {
        ...current,
        ...patch,
        updatedAt: Date.now(),
      };
      db.update(projects)
        .set({ name: next.name, description: next.description, updatedAt: next.updatedAt })
        .where(eq(projects.id, id))
        .run();
      return next;
    },
    remove(id: string): void {
      db.delete(projects).where(eq(projects.id, id)).run();
    },
  };

  const providersRepo = {
    list(): ProviderProfileRecord[] {
      return db
        .select()
        .from(providerProfiles)
        .orderBy(asc(providerProfiles.name))
        .all()
        .map(({ apiKey, ...row }) => ({ ...row, hasApiKey: apiKey.length > 0 }));
    },
    getWithSecret(id: string) {
      return db.select().from(providerProfiles).where(eq(providerProfiles.id, id)).get();
    },
    get(id: string): ProviderProfileRecord | undefined {
      const row = providersRepo.getWithSecret(id);
      if (!row) return undefined;
      const { apiKey: _apiKey, ...rest } = row;
      return { ...rest, hasApiKey: row.apiKey.length > 0 };
    },
    create(input: CreateProviderInput): ProviderProfileRecord {
      const now = Date.now();
      const id = randomUUID();
      db.insert(providerProfiles)
        .values({
          id,
          name: input.name,
          baseUrl: input.baseUrl,
          apiKey: input.apiKey ?? '',
          defaultModel: input.defaultModel ?? '',
          headers: input.headers ?? {},
          createdAt: now,
          updatedAt: now,
        })
        .run();
      return providersRepo.get(id)!;
    },
    update(id: string, patch: UpdateProviderInput): ProviderProfileRecord | undefined {
      const current = providersRepo.getWithSecret(id);
      if (!current) return undefined;
      db.update(providerProfiles)
        .set({
          name: patch.name ?? current.name,
          baseUrl: patch.baseUrl ?? current.baseUrl,
          apiKey: patch.apiKey ?? current.apiKey,
          defaultModel: patch.defaultModel ?? current.defaultModel,
          headers: patch.headers ?? current.headers,
          updatedAt: Date.now(),
        })
        .where(eq(providerProfiles.id, id))
        .run();
      return providersRepo.get(id);
    },
    remove(id: string): void {
      db.delete(providerProfiles).where(eq(providerProfiles.id, id)).run();
    },
  };

  const conversationsRepo = {
    list(projectId: string): ConversationRecord[] {
      return db
        .select()
        .from(conversations)
        .where(eq(conversations.projectId, projectId))
        .orderBy(desc(conversations.updatedAt))
        .all();
    },
    get(id: string): ConversationRecord | undefined {
      return db.select().from(conversations).where(eq(conversations.id, id)).get();
    },
    create(input: CreateConversationInput): ConversationRecord {
      const now = Date.now();
      const record: ConversationRecord = {
        id: randomUUID(),
        projectId: input.projectId,
        title: input.title,
        providerProfileId: input.providerProfileId,
        model: input.model,
        status: 'idle',
        error: null,
        config: input.config,
        createdAt: now,
        updatedAt: now,
      };
      db.insert(conversations).values(record).run();
      return record;
    },
    update(
      id: string,
      patch: Partial<
        Pick<
          ConversationRecord,
          'title' | 'status' | 'error' | 'model' | 'providerProfileId' | 'config'
        >
      >,
    ): ConversationRecord | undefined {
      const current = conversationsRepo.get(id);
      if (!current) return undefined;
      db.update(conversations)
        .set({ ...patch, updatedAt: Date.now() })
        .where(eq(conversations.id, id))
        .run();
      return conversationsRepo.get(id);
    },
    touch(id: string): void {
      db.update(conversations).set({ updatedAt: Date.now() }).where(eq(conversations.id, id)).run();
    },
    remove(id: string): void {
      db.delete(conversations).where(eq(conversations.id, id)).run();
    },
    removeByProject(projectId: string): void {
      db.delete(conversations).where(eq(conversations.projectId, projectId)).run();
    },
  };

  const messagesRepo = {
    list(conversationId: string): MessageRecord[] {
      return db
        .select()
        .from(messages)
        .where(eq(messages.conversationId, conversationId))
        .orderBy(asc(messages.seq))
        .all();
    },
    nextSeq(conversationId: string): number {
      const row = db
        .select({ value: sql<number>`COALESCE(MAX(${messages.seq}), 0)` })
        .from(messages)
        .where(eq(messages.conversationId, conversationId))
        .get();
      return (row?.value ?? 0) + 1;
    },
    create(input: {
      conversationId: string;
      role: MessageRole;
      parts: MessagePart[];
    }): MessageRecord {
      const record: MessageRecord = {
        id: randomUUID(),
        conversationId: input.conversationId,
        seq: messagesRepo.nextSeq(input.conversationId),
        role: input.role,
        parts: input.parts,
        createdAt: Date.now(),
      };
      db.insert(messages).values(record).run();
      return record;
    },
    updateParts(id: string, parts: MessagePart[]): void {
      db.update(messages).set({ parts }).where(eq(messages.id, id)).run();
    },
  };

  const sceneOperationsRepo = {
    list(projectId: string): SceneOperation[] {
      return db
        .select()
        .from(sceneOperations)
        .where(eq(sceneOperations.projectId, projectId))
        .orderBy(asc(sceneOperations.seq))
        .all();
    },
    nextSeq(projectId: string): number {
      const row = db
        .select({ value: sql<number>`COALESCE(MAX(${sceneOperations.seq}), 0)` })
        .from(sceneOperations)
        .where(eq(sceneOperations.projectId, projectId))
        .get();
      return (row?.value ?? 0) + 1;
    },
    create(input: {
      projectId: string;
      conversationId: string | null;
      tool: string;
      input: unknown;
      result: ToolExecutionResult;
    }): SceneOperation {
      const record: SceneOperation = {
        id: randomUUID(),
        projectId: input.projectId,
        conversationId: input.conversationId,
        seq: sceneOperationsRepo.nextSeq(input.projectId),
        tool: input.tool,
        input: input.input,
        result: input.result,
        createdAt: Date.now(),
      };
      db.insert(sceneOperations).values(record).run();
      return record;
    },
    removeMany(projectId: string, ids: string[]): number {
      if (ids.length === 0) return 0;
      const result = db
        .delete(sceneOperations)
        .where(and(eq(sceneOperations.projectId, projectId), inArray(sceneOperations.id, ids)))
        .run();
      return result.changes;
    },
    removeByProject(projectId: string): void {
      db.delete(sceneOperations).where(eq(sceneOperations.projectId, projectId)).run();
    },
  };

  const artifactsRepo = {
    list(projectId: string): ArtifactRecord[] {
      return db
        .select({
          id: artifacts.id,
          projectId: artifacts.projectId,
          conversationId: artifacts.conversationId,
          kind: artifacts.kind,
          filename: artifacts.filename,
          mime: artifacts.mime,
          size: artifacts.size,
          meta: artifacts.meta,
          createdAt: artifacts.createdAt,
        })
        .from(artifacts)
        .where(eq(artifacts.projectId, projectId))
        .orderBy(desc(artifacts.createdAt))
        .all();
    },
    get(id: string): ArtifactRecord | undefined {
      return db
        .select({
          id: artifacts.id,
          projectId: artifacts.projectId,
          conversationId: artifacts.conversationId,
          kind: artifacts.kind,
          filename: artifacts.filename,
          mime: artifacts.mime,
          size: artifacts.size,
          meta: artifacts.meta,
          createdAt: artifacts.createdAt,
        })
        .from(artifacts)
        .where(eq(artifacts.id, id))
        .get();
    },
    getData(id: string): Buffer | undefined {
      const row = db
        .select({ data: artifacts.data })
        .from(artifacts)
        .where(eq(artifacts.id, id))
        .get();
      return row?.data ?? undefined;
    },
    create(input: {
      projectId: string;
      conversationId: string | null;
      kind: ArtifactKind;
      filename: string;
      mime: string;
      data: Buffer;
      meta?: Record<string, unknown>;
    }): ArtifactRecord {
      const record: ArtifactRecord = {
        id: randomUUID(),
        projectId: input.projectId,
        conversationId: input.conversationId,
        kind: input.kind,
        filename: input.filename,
        mime: input.mime,
        size: input.data.byteLength,
        meta: input.meta ?? {},
        createdAt: Date.now(),
      };
      db.insert(artifacts)
        .values({ ...record, data: input.data })
        .run();
      return record;
    },
    remove(id: string): void {
      db.delete(artifacts).where(eq(artifacts.id, id)).run();
    },
  };

  const sceneStateRepo = {
    getMeta(projectId: string): ProjectSceneMeta | undefined {
      const row = db
        .select({
          size: projectScenes.size,
          updatedAt: projectScenes.updatedAt,
          lighting: projectScenes.lighting,
        })
        .from(projectScenes)
        .where(eq(projectScenes.projectId, projectId))
        .get();
      if (!row) return undefined;
      return { size: row.size, updatedAt: row.updatedAt, lighting: row.lighting ?? null };
    },
    getData(projectId: string): Buffer | undefined {
      const row = db
        .select({ glb: projectScenes.glb })
        .from(projectScenes)
        .where(eq(projectScenes.projectId, projectId))
        .get();
      return row?.glb ?? undefined;
    },
    save(
      projectId: string,
      input: { glb: Buffer; lighting: SetupLightingInput | null },
    ): ProjectSceneMeta {
      const now = Date.now();
      const meta: ProjectSceneMeta = {
        size: input.glb.byteLength,
        updatedAt: now,
        lighting: input.lighting,
      };
      db.insert(projectScenes)
        .values({
          projectId,
          glb: input.glb,
          size: meta.size,
          updatedAt: meta.updatedAt,
          lighting: input.lighting,
        })
        .onConflictDoUpdate({
          target: projectScenes.projectId,
          set: {
            glb: input.glb,
            size: meta.size,
            updatedAt: meta.updatedAt,
            lighting: input.lighting,
          },
        })
        .run();
      return meta;
    },
  };

  const conversationStateRepo = {
    get(conversationId: string):
      | { modelMessages: unknown[]; timeline: TimelineItem[]; usage: UsageInfo }
      | undefined {
      const row = db
        .select()
        .from(conversationState)
        .where(eq(conversationState.conversationId, conversationId))
        .get();
      if (!row) return undefined;
      return {
        modelMessages: row.modelMessages,
        timeline: row.timeline,
        usage: row.usage,
      };
    },
    save(
      conversationId: string,
      input: { modelMessages: unknown[]; timeline: TimelineItem[]; usage: UsageInfo },
    ): void {
      const now = Date.now();
      db.insert(conversationState)
        .values({ conversationId, ...input, updatedAt: now })
        .onConflictDoUpdate({
          target: conversationState.conversationId,
          set: { ...input, updatedAt: now },
        })
        .run();
    },
    clearMessages(conversationId: string): void {
      db.update(conversationState)
        .set({ modelMessages: [], updatedAt: Date.now() })
        .where(eq(conversationState.conversationId, conversationId))
        .run();
    },
  };

  return {
    projects: projectsRepo,
    providers: providersRepo,
    conversations: conversationsRepo,
    messages: messagesRepo,
    sceneOperations: sceneOperationsRepo,
    artifacts: artifactsRepo,
    sceneState: sceneStateRepo,
    conversationState: conversationStateRepo,
  };
}

export type Repositories = ReturnType<typeof createRepositories>;
