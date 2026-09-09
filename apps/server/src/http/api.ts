import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { DEFAULT_CONVERSATION_TITLE, type ConversationConfig } from '@llm3d/shared';
import type { SessionManager } from '../conversation/session-manager.js';
import type { ServerConfig } from '../config.js';
import type { Repositories } from '../db/repositories.js';
import { providerRegistry } from '../llm/provider-registry.js';

export interface ApiDeps {
  repos: Repositories;
  manager: SessionManager;
  config: ServerConfig;
}

const projectBodySchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
});

const projectPatchSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
});

const providerBodySchema = z.object({
  name: z.string().min(1),
  baseUrl: z.string().url(),
  apiKey: z.string().optional(),
  defaultModel: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
});

const providerPatchSchema = providerBodySchema.partial();

const conversationConfigSchema = z
  .object({
    maxSteps: z.number().int().min(1).max(100).optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxOutputTokens: z.number().int().min(256).max(200_000).optional(),
    systemPromptExtra: z.string().optional(),
  })
  .optional();

const conversationBodySchema = z.object({
  title: z.string().min(1).optional(),
  providerProfileId: z.string().min(1),
  model: z.string().min(1),
  config: conversationConfigSchema,
});

const conversationPatchSchema = z.object({
  title: z.string().min(1).optional(),
  providerProfileId: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  resetContext: z.boolean().optional(),
});

const pruneOperationsSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(200),
});

function invalid(reply: FastifyReply, message: string) {
  return reply.code(400).send({ error: message });
}

export async function registerApi(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  const { repos, manager } = deps;

  app.get('/api/health', async () => ({
    ok: true,
    service: 'llm3d-server',
    time: Date.now(),
  }));

  // ---- Projects ---------------------------------------------------------------
  app.get('/api/projects', async () => repos.projects.list());

  app.post('/api/projects', async (request, reply) => {
    const parsed = projectBodySchema.safeParse(request.body);
    if (!parsed.success) return invalid(reply, parsed.error.message);
    return reply.code(201).send(repos.projects.create(parsed.data));
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id', async (request, reply) => {
    const project = repos.projects.get(request.params.id);
    if (!project) return reply.code(404).send({ error: 'Project not found' });
    return { project, conversations: repos.conversations.list(project.id) };
  });

  app.patch<{ Params: { id: string } }>('/api/projects/:id', async (request, reply) => {
    const parsed = projectPatchSchema.safeParse(request.body);
    if (!parsed.success) return invalid(reply, parsed.error.message);
    const project = repos.projects.update(request.params.id, parsed.data);
    if (!project) return reply.code(404).send({ error: 'Project not found' });
    return project;
  });

  app.delete<{ Params: { id: string } }>('/api/projects/:id', async (request, reply) => {
    manager.removeProject(request.params.id);
    return reply.code(204).send();
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id/conversations', async (request, reply) => {
    if (!repos.projects.get(request.params.id)) {
      return reply.code(404).send({ error: 'Project not found' });
    }
    return repos.conversations.list(request.params.id);
  });

  app.post<{ Params: { id: string } }>('/api/projects/:id/conversations', async (request, reply) => {
    const parsed = conversationBodySchema.safeParse(request.body);
    if (!parsed.success) return invalid(reply, parsed.error.message);
    if (!repos.projects.get(request.params.id)) return invalid(reply, 'Project not found');
    if (!repos.providers.get(parsed.data.providerProfileId)) {
      return invalid(reply, 'Provider profile not found');
    }
    const conversation = manager.create({
      projectId: request.params.id,
      title: parsed.data.title ?? DEFAULT_CONVERSATION_TITLE,
      providerProfileId: parsed.data.providerProfileId,
      model: parsed.data.model,
      config: parsed.data.config as Partial<ConversationConfig> | undefined,
    });
    return reply.code(201).send(conversation.conversation);
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id/operations', async (request, reply) => {
    if (!repos.projects.get(request.params.id)) {
      return reply.code(404).send({ error: 'Project not found' });
    }
    return repos.sceneOperations.list(request.params.id);
  });

  app.post<{ Params: { id: string } }>(
    '/api/projects/:id/operations/prune',
    async (request, reply) => {
      const parsed = pruneOperationsSchema.safeParse(request.body);
      if (!parsed.success) return invalid(reply, parsed.error.message);
      const hub = manager.getHub(request.params.id);
      if (!hub) return reply.code(404).send({ error: 'Project not found' });
      const removed = hub.removeOperations(parsed.data.ids);
      return { removed, operations: repos.sceneOperations.list(request.params.id) };
    },
  );

  app.get<{ Params: { id: string } }>('/api/projects/:id/artifacts', async (request, reply) => {
    if (!repos.projects.get(request.params.id)) {
      return reply.code(404).send({ error: 'Project not found' });
    }
    return repos.artifacts.list(request.params.id);
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id/scene', async (request, reply) => {
    if (!repos.projects.get(request.params.id)) {
      return reply.code(404).send({ error: 'Project not found' });
    }
    const data = repos.sceneState.getData(request.params.id);
    if (!data) return reply.code(404).send({ error: 'Scene not found' });
    return reply
      .header('Content-Type', 'model/gltf-binary')
      .header('Cache-Control', 'no-store')
      .send(data);
  });

  // ---- Conversations ----------------------------------------------------------
  app.get<{ Params: { id: string } }>('/api/conversations/:id', async (request, reply) => {
    const conversation = repos.conversations.get(request.params.id);
    if (!conversation) return reply.code(404).send({ error: 'Conversation not found' });
    return conversation;
  });

  app.get<{ Params: { id: string } }>('/api/conversations/:id/snapshot', async (request, reply) => {
    const conversation = manager.getOrLoad(request.params.id);
    if (!conversation) return reply.code(404).send({ error: 'Conversation not found' });
    return conversation.getSnapshot();
  });

  app.patch<{ Params: { id: string } }>('/api/conversations/:id', async (request, reply) => {
    const parsed = conversationPatchSchema.safeParse(request.body);
    if (!parsed.success) return invalid(reply, parsed.error.message);
    const conversation = manager.getOrLoad(request.params.id);
    if (!conversation) return reply.code(404).send({ error: 'Conversation not found' });
    if (parsed.data.providerProfileId && !repos.providers.get(parsed.data.providerProfileId)) {
      return invalid(reply, 'Provider profile not found');
    }
    try {
      return conversation.update(parsed.data);
    } catch (error) {
      return reply.code(409).send({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.delete<{ Params: { id: string } }>('/api/conversations/:id', async (request, reply) => {
    manager.remove(request.params.id);
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>('/api/conversations/:id/cancel', async (request, reply) => {
    const conversation = manager.getOrLoad(request.params.id);
    if (!conversation) return reply.code(404).send({ error: 'Conversation not found' });
    conversation.cancel();
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>('/api/conversations/:id/messages', async (request, reply) => {
    if (!repos.conversations.get(request.params.id)) {
      return reply.code(404).send({ error: 'Conversation not found' });
    }
    return repos.messages.list(request.params.id);
  });

  // ---- Providers --------------------------------------------------------------
  app.get('/api/providers', async () => repos.providers.list());

  app.post('/api/providers', async (request, reply) => {
    const parsed = providerBodySchema.safeParse(request.body);
    if (!parsed.success) return invalid(reply, parsed.error.message);
    return reply.code(201).send(repos.providers.create(parsed.data));
  });

  app.patch<{ Params: { id: string } }>('/api/providers/:id', async (request, reply) => {
    const parsed = providerPatchSchema.safeParse(request.body);
    if (!parsed.success) return invalid(reply, parsed.error.message);
    const provider = repos.providers.update(request.params.id, parsed.data);
    if (!provider) return reply.code(404).send({ error: 'Provider not found' });
    return provider;
  });

  app.delete<{ Params: { id: string } }>('/api/providers/:id', async (request, reply) => {
    repos.providers.remove(request.params.id);
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>('/api/providers/:id/test', async (request, reply) => {
    const profile = repos.providers.getWithSecret(request.params.id);
    if (!profile) return reply.code(404).send({ error: 'Provider not found' });
    try {
      const models = await providerRegistry.listModels(profile);
      return { ok: true, modelCount: models.length, sample: models.slice(0, 8) };
    } catch (error) {
      return reply.code(502).send({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.get<{ Params: { id: string } }>('/api/providers/:id/models', async (request, reply) => {
    const profile = repos.providers.getWithSecret(request.params.id);
    if (!profile) return reply.code(404).send({ error: 'Provider not found' });
    try {
      return { models: await providerRegistry.listModels(profile) };
    } catch (error) {
      return reply.code(502).send({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // ---- Artifacts --------------------------------------------------------------
  app.get<{ Params: { id: string } }>('/api/artifacts/:id', async (request, reply) => {
    const artifact = repos.artifacts.get(request.params.id);
    if (!artifact) return reply.code(404).send({ error: 'Artifact not found' });
    return artifact;
  });

  app.get<{ Params: { id: string } }>('/api/artifacts/:id/download', async (request, reply) => {
    const artifact = repos.artifacts.get(request.params.id);
    const data = repos.artifacts.getData(request.params.id);
    if (!artifact || !data) return reply.code(404).send({ error: 'Artifact not found' });
    return reply
      .header('Content-Type', artifact.mime)
      .header('Content-Disposition', `attachment; filename="${artifact.filename}"`)
      .send(data);
  });
}
