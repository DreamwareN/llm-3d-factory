import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify from 'fastify';
import { existsSync } from 'node:fs';
import { SessionManager } from './conversation/session-manager.js';
import { config } from './config.js';
import { createDatabase } from './db/client.js';
import { migrate } from './db/migrate.js';
import { createRepositories } from './db/repositories.js';
import { registerApi } from './http/api.js';
import { registerGateway } from './ws/gateway.js';

async function main(): Promise<void> {
  const database = createDatabase(config.databasePath);
  migrate(database);
  const repos = createRepositories(database.db);
  const manager = new SessionManager({ repos, config });

  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    bodyLimit: 32 * 1024 * 1024,
  });

  await app.register(cors, {
    origin: config.corsOrigins.length > 0 ? config.corsOrigins : true,
  });
  await app.register(websocket, {
    options: { maxPayload: 32 * 1024 * 1024 },
  });
  await registerGateway(app, manager);
  await registerApi(app, { repos, manager, config });

  if (existsSync(config.webDistPath)) {
    await app.register(fastifyStatic, {
      root: config.webDistPath,
      prefix: '/',
      wildcard: false,
    });
    app.setNotFoundHandler((request, reply) => {
      if (
        request.method === 'GET' &&
        !request.url.startsWith('/api') &&
        !request.url.startsWith('/ws')
      ) {
        return reply.sendFile('index.html');
      }
      return reply.code(404).send({ error: 'Not found' });
    });
  }

  await app.listen({ host: config.host, port: config.port });
  app.log.info(`LLM 3D Factory server ready on http://${config.host}:${config.port}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
