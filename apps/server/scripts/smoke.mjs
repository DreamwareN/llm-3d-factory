#!/usr/bin/env node
/**
 * End-to-end smoke test: starts the mock provider and the API server, runs a
 * conversation through the WebSocket protocol with a mocked browser preview,
 * and verifies the RFC-002 tool loop produced scene operations and artifacts.
 *
 * Usage: node scripts/smoke.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockPreview } from './mock-preview.mjs';

const PORT = 8790;
const PROVIDER_PORT = 9999;
const BASE = `http://127.0.0.1:${PORT}`;

const workDir = mkdtempSync(join(tmpdir(), 'llm3d-smoke-'));
const dbPath = join(workDir, 'smoke.sqlite');

const children = [];
function start(command, args, options = {}) {
  const child = spawn(command, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
    ...options,
  });
  child.stdout.on('data', (data) => process.stdout.write(`  │ ${data}`));
  child.stderr.on('data', (data) => process.stderr.write(`  │ ${data}`));
  children.push(child);
  return child;
}

function cleanup(code) {
  for (const child of children) {
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        child.kill('SIGTERM');
      }
    } catch {
      // ignore
    }
  }
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
  setTimeout(() => process.exit(code), 300);
}

async function waitForHealth(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/api/health`);
      if (response.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error('Server did not become healthy in time');
}

async function api(path, init) {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!response.ok) {
    throw new Error(`${init?.method ?? 'GET'} ${path} -> ${response.status} ${await response.text()}`);
  }
  return response.json();
}

function envelope(fields) {
  return JSON.stringify({ v: 2, id: crypto.randomUUID(), ts: Date.now(), ...fields });
}

async function main() {
  console.log('[smoke] starting fake provider…');
  start('node', ['scripts/fake-provider.mjs', String(PROVIDER_PORT)]);

  console.log('[smoke] starting api server…');
  start('pnpm', ['exec', 'tsx', 'src/index.ts'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      DATABASE_PATH: dbPath,
      LOG_LEVEL: 'warn',
    },
  });

  await waitForHealth();
  console.log('[smoke] server healthy');

  const project = await api('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name: 'Smoke Project' }),
  });
  const provider = await api('/api/providers', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Mock',
      baseUrl: `http://127.0.0.1:${PROVIDER_PORT}/v1`,
      apiKey: 'fake-key',
      defaultModel: 'mock-model',
    }),
  });
  const conversation = await api(`/api/projects/${project.id}/conversations`, {
    method: 'POST',
    body: JSON.stringify({
      title: 'Smoke Scene',
      providerProfileId: provider.id,
      model: 'mock-model',
      config: { maxSteps: 8, temperature: 0 },
    }),
  });
  console.log(`[smoke] conversation created: ${conversation.id}`);

  const preview = createMockPreview();
  const clientTools = [];
  const operations = [];
  const fakeGlb = Buffer.concat([Buffer.from('glTF'), Buffer.alloc(32, 7)]);
  const fakeGlbBase64 = fakeGlb.toString('base64');

  const completed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for turn to finish')), 30_000);
    const socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    let turnStatus = null;
    socket.onopen = () => {
      socket.send(envelope({ type: 'preview.ready', projectId: project.id }));
      socket.send(envelope({ type: 'project.subscribe', projectId: project.id }));
      socket.send(envelope({ type: 'conversation.subscribe', conversationId: conversation.id }));
      socket.send(
        envelope({
          type: 'conversation.start',
          conversationId: conversation.id,
          prompt: 'Build a small demo scene.',
        }),
      );
    };
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.type === 'tool.client_request') {
        clientTools.push(message.request.name);
        const result = preview.execute(message.request.name, message.request.input);
        socket.send(
          envelope({
            type: 'client.tool_result',
            conversationId: conversation.id,
            requestId: message.request.requestId,
            ok: true,
            result,
          }),
        );
      }
      if (message.type === 'scene.operation') operations.push(message.operation);
      if (message.type === 'error') console.log(`[smoke] error: ${message.message}`);
      if (message.type === 'conversation.error') console.log(`[smoke] conversation.error: ${message.message}`);
      if (message.type === 'conversation.turn_finished') {
        turnStatus = message.status;
        // The browser normally exports the sandbox scene and uploads it here.
        socket.send(
          envelope({
            type: 'scene.snapshot',
            projectId: project.id,
            conversationId: conversation.id,
            dataBase64: fakeGlbBase64,
            lighting: { preset: 'studio_soft' },
          }),
        );
      }
      if (message.type === 'scene.updated') {
        clearTimeout(timer);
        socket.close();
        resolve({ status: turnStatus, scene: message.scene });
      }
    };
    socket.onerror = () => reject(new Error('WebSocket error'));
  });

  const { status, scene } = await completed;

  const snapshot = await api(`/api/conversations/${conversation.id}/snapshot`);
  const artifacts = await api(`/api/projects/${project.id}/artifacts`);
  const sceneResponse = await fetch(`${BASE}/api/projects/${project.id}/scene`);
  const sceneBytes = sceneResponse.ok
    ? Buffer.from(await sceneResponse.arrayBuffer())
    : Buffer.alloc(0);

  const failures = [];
  if (status !== 'idle') failures.push(`conversation status was ${status}, expected idle`);
  if (operations.length < 3) failures.push(`expected >= 3 scene operations, got ${operations.length}`);
  if (!clientTools.includes('create_primitive')) failures.push('create_primitive was not called');
  if (!clientTools.includes('capture_viewport')) failures.push('capture_viewport was not called');
  if (artifacts.length < 2) failures.push(`expected >= 2 artifacts (png+glb), got ${artifacts.length}`);
  if (snapshot.timeline.some((item) => item.status === 'error')) {
    failures.push('timeline contains an error item');
  }
  const assistantMessages = snapshot.messages.filter((message) => message.role === 'assistant');
  if (assistantMessages.length === 0) failures.push('no assistant messages persisted');
  if (!sceneResponse.ok) failures.push(`GET /scene returned ${sceneResponse.status}`);
  if (sceneBytes.toString('ascii', 0, 4) !== 'glTF') failures.push('scene endpoint did not return GLB data');
  if (scene?.size !== fakeGlb.length) failures.push(`scene meta size was ${scene?.size}, expected ${fakeGlb.length}`);
  if (scene?.lighting?.preset !== 'studio_soft') failures.push('scene lighting was not persisted');

  console.log(
    `[smoke] clientTools=[${clientTools.join(', ')}] operations=${operations.length} artifacts=${artifacts.length}`,
  );

  if (failures.length > 0) {
    console.error('\n[smoke] FAILED:');
    for (const failure of failures) console.error(`  - ${failure}`);
    cleanup(1);
    return;
  }
  console.log('\n[smoke] PASSED');
  cleanup(0);
}

main().catch((error) => {
  console.error('[smoke] fatal:', error);
  cleanup(1);
});
