export type ConversationStatus = 'idle' | 'running' | 'failed';

export const DEFAULT_CONVERSATION_TITLE = '新对话';

export type ArtifactKind = 'glb' | 'png' | 'json';

export type Vec3 = [number, number, number];

export interface BoundingBox {
  min: Vec3;
  max: Vec3;
  size: Vec3;
  center: Vec3;
}

export interface PBRMaterialConfig {
  color?: string;
  roughness?: number;
  metalness?: number;
  transmission?: number;
  opacity?: number;
  wireframe?: boolean;
}

export interface ToolExecutionResult {
  success: boolean;
  object_id?: string;
  affected_ids?: string[];
  aabb?: BoundingBox;
  message?: string;
  error_code?: string;
  error?: string;
  suggestion?: string;
  data?: unknown;
}

export interface ProjectRecord {
  id: string;
  name: string;
  description: string;
  createdAt: number;
  updatedAt: number;
}

export interface ProviderProfileRecord {
  id: string;
  name: string;
  baseUrl: string;
  defaultModel: string;
  hasApiKey: boolean;
  headers: Record<string, string>;
  createdAt: number;
  updatedAt: number;
}

export interface ConversationConfig {
  temperature?: number;
  maxSteps: number;
  maxOutputTokens?: number;
  systemPromptExtra?: string;
}

export interface ConversationRecord {
  id: string;
  projectId: string;
  title: string;
  providerProfileId: string;
  model: string;
  status: ConversationStatus;
  error: string | null;
  config: ConversationConfig;
  createdAt: number;
  updatedAt: number;
}

export type MessageRole = 'user' | 'assistant' | 'system';

export type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | {
      type: 'tool-call';
      callId: string;
      name: string;
      input: unknown;
      state: 'running' | 'done' | 'error';
      result?: unknown;
      error?: string;
      startedAt: number;
      endedAt?: number;
    }
  | { type: 'error'; message: string };

export interface MessageRecord {
  id: string;
  conversationId: string;
  seq: number;
  role: MessageRole;
  parts: MessagePart[];
  createdAt: number;
}

/** One successful scene-mutating tool call. Kept as an audit trail; the scene itself is persisted as a GLB snapshot. */
export interface SceneOperation {
  id: string;
  projectId: string;
  conversationId: string | null;
  seq: number;
  tool: string;
  input: unknown;
  result: ToolExecutionResult;
  createdAt: number;
}

export interface ArtifactRecord {
  id: string;
  projectId: string;
  conversationId: string | null;
  kind: ArtifactKind;
  filename: string;
  mime: string;
  size: number;
  meta: Record<string, unknown>;
  createdAt: number;
}

export interface UsageInfo {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
}

export type TimelineKind = 'status' | 'step' | 'tool' | 'scene' | 'artifact' | 'error';

export interface TimelineItem {
  id: string;
  kind: TimelineKind;
  title: string;
  detail?: string;
  status: 'pending' | 'running' | 'done' | 'error';
  startedAt: number;
  endedAt?: number;
  meta?: Record<string, unknown>;
}

export interface SceneStats {
  objectCount: number;
  meshCount: number;
  triangleCount: number;
  vertexCount: number;
}

export interface SceneNodeInfo {
  object_id: string;
  name: string;
  type: string;
  visible: boolean;
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
  geometry?: Record<string, unknown>;
  material?: Record<string, unknown>;
  aabb?: BoundingBox;
  children?: SceneNodeInfo[];
}

export interface SceneInfo {
  stats: SceneStats;
  objects: SceneNodeInfo[];
  camera: {
    type: string;
    position: Vec3;
    target: Vec3;
    fov?: number;
  };
  renderer: {
    width: number;
    height: number;
    pixelRatio: number;
  };
}

export interface ConversationSnapshot {
  conversation: ConversationRecord;
  messages: MessageRecord[];
  timeline: TimelineItem[];
  usage: UsageInfo;
  pendingClientTools: ClientToolRequest[];
}

export interface ProjectSceneMeta {
  updatedAt: number;
  size: number;
  lighting: import('./tools.js').SetupLightingInput | null;
}

export interface ProjectSnapshot {
  project: ProjectRecord;
  conversations: ConversationRecord[];
  operations: SceneOperation[];
  artifacts: ArtifactRecord[];
  scene: ProjectSceneMeta | null;
}

export interface ClientToolRequest {
  requestId: string;
  callId: string;
  projectId: string;
  conversationId: string;
  name: import('./tools.js').ClientToolName;
  input: unknown;
  timeoutMs: number;
  createdAt: number;
}
