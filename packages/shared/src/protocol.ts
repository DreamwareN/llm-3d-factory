import { z } from 'zod';
import { PROTOCOL_VERSION } from './version.js';
import { setupLightingInputSchema } from './tools.js';
import type {
  ArtifactRecord,
  ClientToolRequest,
  ConversationRecord,
  ConversationSnapshot,
  ConversationStatus,
  MessageRecord,
  ProjectSceneMeta,
  ProjectSnapshot,
  SceneOperation,
  TimelineItem,
  UsageInfo,
} from './domain.js';

const envelopeShape = {
  v: z.literal(PROTOCOL_VERSION),
  id: z.string(),
  ts: z.number(),
};

export const projectSubscribeSchema = z.object({
  ...envelopeShape,
  type: z.literal('project.subscribe'),
  projectId: z.string(),
});

export const projectUnsubscribeSchema = z.object({
  ...envelopeShape,
  type: z.literal('project.unsubscribe'),
  projectId: z.string(),
});

export const conversationSubscribeSchema = z.object({
  ...envelopeShape,
  type: z.literal('conversation.subscribe'),
  conversationId: z.string(),
});

export const conversationUnsubscribeSchema = z.object({
  ...envelopeShape,
  type: z.literal('conversation.unsubscribe'),
  conversationId: z.string(),
});

export const conversationStartSchema = z.object({
  ...envelopeShape,
  type: z.literal('conversation.start'),
  conversationId: z.string(),
  prompt: z.string().min(1),
});

export const conversationUserMessageSchema = z.object({
  ...envelopeShape,
  type: z.literal('conversation.user_message'),
  conversationId: z.string(),
  text: z.string().min(1),
});

export const conversationCancelSchema = z.object({
  ...envelopeShape,
  type: z.literal('conversation.cancel'),
  conversationId: z.string(),
});

export const clientToolResultSchema = z.object({
  ...envelopeShape,
  type: z.literal('client.tool_result'),
  conversationId: z.string(),
  requestId: z.string(),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().optional(),
});

export const clientToolAckSchema = z.object({
  ...envelopeShape,
  type: z.literal('client.tool_ack'),
  conversationId: z.string(),
  requestId: z.string(),
});

export const previewReadySchema = z.object({
  ...envelopeShape,
  type: z.literal('preview.ready'),
  projectId: z.string(),
});

export const previewDetachSchema = z.object({
  ...envelopeShape,
  type: z.literal('preview.detach'),
  projectId: z.string(),
});

export const sceneSnapshotSchema = z.object({
  ...envelopeShape,
  type: z.literal('scene.snapshot'),
  projectId: z.string(),
  conversationId: z.string().optional(),
  dataBase64: z.string().min(1),
  lighting: setupLightingInputSchema.optional(),
});

export const pingSchema = z.object({
  ...envelopeShape,
  type: z.literal('ping'),
});

export const clientMessageSchema = z.discriminatedUnion('type', [
  projectSubscribeSchema,
  projectUnsubscribeSchema,
  conversationSubscribeSchema,
  conversationUnsubscribeSchema,
  conversationStartSchema,
  conversationUserMessageSchema,
  conversationCancelSchema,
  clientToolResultSchema,
  clientToolAckSchema,
  previewReadySchema,
  previewDetachSchema,
  sceneSnapshotSchema,
  pingSchema,
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;
export type ClientMessageType = ClientMessage['type'];

export interface ServerEnvelope {
  v: typeof PROTOCOL_VERSION;
  id: string;
  ts: number;
}

export type ServerMessage = ServerEnvelope &
  (
    | { type: 'project.snapshot'; projectId: string; snapshot: ProjectSnapshot }
    | {
        type: 'conversation.snapshot';
        projectId: string;
        conversationId: string;
        snapshot: ConversationSnapshot;
      }
    | {
        type: 'conversation.status';
        projectId: string;
        conversationId: string;
        status: ConversationStatus;
        error?: string | null;
      }
    | {
        type: 'conversation.updated';
        projectId: string;
        conversationId: string;
        conversation: ConversationRecord;
      }
    | { type: 'conversation.error'; projectId: string; conversationId: string; message: string }
    | {
        type: 'conversation.turn_finished';
        projectId: string;
        conversationId: string;
        status: ConversationStatus;
      }
    | { type: 'message.added'; conversationId: string; message: MessageRecord }
    | {
        type: 'message.delta';
        conversationId: string;
        messageId: string;
        part: 'text' | 'reasoning';
        delta: string;
      }
    | { type: 'message.updated'; conversationId: string; message: MessageRecord }
    | { type: 'timeline.added'; conversationId: string; item: TimelineItem }
    | { type: 'timeline.updated'; conversationId: string; item: TimelineItem }
    | {
        type: 'tool.client_request';
        projectId: string;
        conversationId: string;
        request: ClientToolRequest;
      }
    | { type: 'tool.cancel'; projectId: string; conversationId: string; requestId: string }
    | { type: 'scene.operation'; projectId: string; operation: SceneOperation }
    | { type: 'scene.operations_pruned'; projectId: string; ids: string[] }
    | { type: 'scene.updated'; projectId: string; scene: ProjectSceneMeta }
    | { type: 'artifact.created'; projectId: string; artifact: ArtifactRecord }
    | { type: 'usage'; conversationId: string; usage: UsageInfo }
    | {
        type: 'error';
        message: string;
        projectId?: string;
        conversationId?: string;
      }
    | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string; projectId?: string }
    | { type: 'pong' }
  );

export type ServerMessageType = ServerMessage['type'];

export function makeEnvelope(): ServerEnvelope {
  return {
    v: PROTOCOL_VERSION,
    id: crypto.randomUUID(),
    ts: Date.now(),
  };
}
