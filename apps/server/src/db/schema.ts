import { integer, sqliteTable, text, uniqueIndex, index, blob } from 'drizzle-orm/sqlite-core';
import type {
  ArtifactKind,
  ConversationConfig,
  ConversationStatus,
  MessagePart,
  MessageRole,
  SetupLightingInput,
  TimelineItem,
  ToolExecutionResult,
  UsageInfo,
} from '@llm3d/shared';

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const providerProfiles = sqliteTable('provider_profiles', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  baseUrl: text('base_url').notNull(),
  apiKey: text('api_key').notNull().default(''),
  defaultModel: text('default_model').notNull().default(''),
  headers: text('headers', { mode: 'json' }).$type<Record<string, string>>().notNull().default({}),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const conversations = sqliteTable(
  'conversations',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    providerProfileId: text('provider_profile_id').notNull(),
    model: text('model').notNull(),
    status: text('status').$type<ConversationStatus>().notNull().default('idle'),
    error: text('error'),
    config: text('config', { mode: 'json' }).$type<ConversationConfig>().notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [index('conversations_project_idx').on(table.projectId, table.updatedAt)],
);

export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    role: text('role').$type<MessageRole>().notNull(),
    parts: text('parts', { mode: 'json' }).$type<MessagePart[]>().notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [index('messages_conversation_seq').on(table.conversationId, table.seq)],
);

export const sceneOperations = sqliteTable(
  'scene_operations',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    conversationId: text('conversation_id').references(() => conversations.id, {
      onDelete: 'set null',
    }),
    seq: integer('seq').notNull(),
    tool: text('tool').notNull(),
    input: text('input', { mode: 'json' }).$type<unknown>().notNull(),
    result: text('result', { mode: 'json' }).$type<ToolExecutionResult>().notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [uniqueIndex('scene_operations_project_seq').on(table.projectId, table.seq)],
);

export const artifacts = sqliteTable(
  'artifacts',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    conversationId: text('conversation_id').references(() => conversations.id, {
      onDelete: 'set null',
    }),
    kind: text('kind').$type<ArtifactKind>().notNull(),
    filename: text('filename').notNull(),
    mime: text('mime').notNull(),
    size: integer('size').notNull(),
    data: blob('data', { mode: 'buffer' }),
    meta: text('meta', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [index('artifacts_project_idx').on(table.projectId, table.createdAt)],
);

/** The project's authoritative scene state: the latest GLB snapshot plus scene-level lighting. */
export const projectScenes = sqliteTable('project_scenes', {
  projectId: text('project_id')
    .primaryKey()
    .references(() => projects.id, { onDelete: 'cascade' }),
  glb: blob('glb', { mode: 'buffer' }).notNull(),
  lighting: text('lighting', { mode: 'json' }).$type<SetupLightingInput | null>(),
  size: integer('size').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const conversationState = sqliteTable('conversation_state', {
  conversationId: text('conversation_id')
    .primaryKey()
    .references(() => conversations.id, { onDelete: 'cascade' }),
  modelMessages: text('model_messages', { mode: 'json' }).$type<unknown[]>().notNull().default([]),
  timeline: text('timeline', { mode: 'json' }).$type<TimelineItem[]>().notNull().default([]),
  usage: text('usage', { mode: 'json' }).$type<UsageInfo>().notNull().default({}),
  updatedAt: integer('updated_at').notNull(),
});
