import type { DatabaseHandle } from './client.js';

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS provider_profiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    api_key TEXT NOT NULL DEFAULT '',
    default_model TEXT NOT NULL DEFAULT '',
    headers TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    provider_profile_id TEXT NOT NULL,
    model TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'idle',
    error TEXT,
    config TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS conversations_project_idx ON conversations(project_id, updated_at)`,
  `CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    role TEXT NOT NULL,
    parts TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS messages_conversation_seq ON messages(conversation_id, seq)`,
  `CREATE TABLE IF NOT EXISTS scene_operations (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
    seq INTEGER NOT NULL,
    tool TEXT NOT NULL,
    input TEXT NOT NULL,
    result TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS scene_operations_project_seq ON scene_operations(project_id, seq)`,
  `CREATE TABLE IF NOT EXISTS artifacts (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
    kind TEXT NOT NULL,
    filename TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    data BLOB,
    meta TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS artifacts_project_idx ON artifacts(project_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS project_scenes (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    glb BLOB NOT NULL,
    lighting TEXT,
    size INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS conversation_state (
    conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
    model_messages TEXT NOT NULL DEFAULT '[]',
    timeline TEXT NOT NULL DEFAULT '[]',
    usage TEXT NOT NULL DEFAULT '{}',
    updated_at INTEGER NOT NULL
  )`,
];

export function migrate(handle: DatabaseHandle): void {
  for (const statement of STATEMENTS) {
    handle.sqlite.exec(statement);
  }
}
