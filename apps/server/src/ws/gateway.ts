import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { clientMessageSchema, makeEnvelope, type ClientMessage } from '@llm3d/shared';
import type { ServerEvent } from '../conversation/events.js';
import type { SessionManager } from '../conversation/session-manager.js';

interface ClientContext {
  id: string;
  socket: WebSocket;
  projectSubscriptions: Map<string, () => void>;
  conversationSubscriptions: Map<string, () => void>;
}

export async function registerGateway(
  app: FastifyInstance,
  manager: SessionManager,
): Promise<void> {
  const clients = new Set<ClientContext>();

  app.get('/ws', { websocket: true }, (socket, request) => {
    const context: ClientContext = {
      id: (request.headers['x-client-id'] as string | undefined) ?? crypto.randomUUID(),
      socket,
      projectSubscriptions: new Map(),
      conversationSubscriptions: new Map(),
    };
    clients.add(context);
    app.log.info({ clientId: context.id }, 'websocket connected');

    const send = (message: ServerEvent): void => {
      if (socket.readyState !== socket.OPEN) return;
      socket.send(JSON.stringify({ ...makeEnvelope(), ...message }));
    };

    const subscribeProject = (projectId: string): void => {
      if (context.projectSubscriptions.has(projectId)) return;
      const hub = manager.getHub(projectId);
      if (!hub) {
        send({ type: 'error', projectId, message: `Project ${projectId} not found.` });
        return;
      }
      const unsubscribe = hub.subscribe((event) => send(event));
      context.projectSubscriptions.set(projectId, unsubscribe);
      send({ type: 'project.snapshot', projectId, snapshot: hub.getSnapshot() });
    };

    const subscribeConversation = (conversationId: string): void => {
      if (context.conversationSubscriptions.has(conversationId)) return;
      const session = manager.getOrLoad(conversationId);
      if (!session) {
        send({ type: 'error', conversationId, message: `Conversation ${conversationId} not found.` });
        return;
      }
      const hub = manager.getHub(session.projectId);
      const unsubscribe = session.subscribe((event) => {
        if (event.type === 'tool.client_request' && !hub?.getPreviewClientIds().includes(context.id)) {
          return;
        }
        send(event);
      });
      context.conversationSubscriptions.set(conversationId, unsubscribe);
      send({
        type: 'conversation.snapshot',
        projectId: session.projectId,
        conversationId,
        snapshot: session.getSnapshot(),
      });
    };

    const unsubscribeProject = (projectId: string): void => {
      const entry = context.projectSubscriptions.get(projectId);
      if (entry) entry();
      context.projectSubscriptions.delete(projectId);
      manager.getHub(projectId)?.setPreviewClient(context.id, false);
    };

    const unsubscribeConversation = (conversationId: string): void => {
      const entry = context.conversationSubscriptions.get(conversationId);
      if (entry) entry();
      context.conversationSubscriptions.delete(conversationId);
    };

    socket.on('message', (raw) => {
      let parsed: ClientMessage;
      try {
        const json = JSON.parse(raw.toString()) as unknown;
        const result = clientMessageSchema.safeParse(json);
        if (!result.success) {
          app.log.warn({ issues: result.error.issues }, 'invalid websocket message');
          return;
        }
        parsed = result.data;
      } catch {
        return;
      }

      switch (parsed.type) {
        case 'project.subscribe':
          subscribeProject(parsed.projectId);
          break;
        case 'project.unsubscribe':
          unsubscribeProject(parsed.projectId);
          break;
        case 'conversation.subscribe':
          subscribeConversation(parsed.conversationId);
          break;
        case 'conversation.unsubscribe':
          unsubscribeConversation(parsed.conversationId);
          break;
        case 'conversation.start': {
          subscribeConversation(parsed.conversationId);
          void manager.runTurn(parsed.conversationId, { prompt: parsed.prompt }).catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            send({ type: 'error', conversationId: parsed.conversationId, message });
          });
          break;
        }
        case 'conversation.user_message': {
          void manager.runTurn(parsed.conversationId, { text: parsed.text }).catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            send({ type: 'error', conversationId: parsed.conversationId, message });
          });
          break;
        }
        case 'conversation.cancel':
          manager.getOrLoad(parsed.conversationId)?.cancel();
          break;
        case 'client.tool_result':
          manager
            .getOrLoad(parsed.conversationId)
            ?.handleClientToolResult(parsed.requestId, parsed.ok, parsed.result, parsed.error);
          break;
        case 'client.tool_ack':
          manager.getOrLoad(parsed.conversationId)?.ackClientTool(parsed.requestId);
          break;
        case 'preview.ready':
          manager.getHub(parsed.projectId)?.setPreviewClient(context.id, true);
          break;
        case 'preview.detach':
          manager.getHub(parsed.projectId)?.setPreviewClient(context.id, false);
          break;
        case 'scene.snapshot': {
          if (!context.projectSubscriptions.has(parsed.projectId)) break;
          const hub = manager.getHub(parsed.projectId);
          if (!hub) break;
          const data = Buffer.from(parsed.dataBase64, 'base64');
          if (data.byteLength < 12 || data.toString('ascii', 0, 4) !== 'glTF') {
            app.log.warn(
              { projectId: parsed.projectId, bytes: data.byteLength },
              'rejected invalid scene snapshot',
            );
            break;
          }
          try {
            hub.saveScene({ glb: data, lighting: parsed.lighting ?? null });
          } catch (error) {
            app.log.warn({ err: error, projectId: parsed.projectId }, 'failed to save scene snapshot');
          }
          break;
        }
        case 'ping':
          send({ type: 'pong' });
          break;
        default:
          break;
      }
    });

    socket.on('close', () => {
      clients.delete(context);
      for (const [projectId, unsubscribe] of context.projectSubscriptions) {
        unsubscribe();
        manager.getHub(projectId)?.setPreviewClient(context.id, false);
      }
      for (const unsubscribe of context.conversationSubscriptions.values()) {
        unsubscribe();
      }
      context.projectSubscriptions.clear();
      context.conversationSubscriptions.clear();
      app.log.info({ clientId: context.id }, 'websocket disconnected');
    });

    socket.on('error', (error) => {
      app.log.warn({ err: error, clientId: context.id }, 'websocket error');
    });
  });

  const heartbeat = setInterval(() => {
    for (const context of clients) {
      if (context.socket.readyState !== context.socket.OPEN) continue;
      context.socket.ping();
    }
  }, 30_000);

  app.addHook('onClose', async () => {
    clearInterval(heartbeat);
    for (const context of clients) {
      context.socket.close();
    }
  });
}
