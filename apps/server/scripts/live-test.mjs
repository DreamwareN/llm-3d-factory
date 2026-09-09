#!/usr/bin/env node
/**
 * Live end-to-end test against a real OpenAI-compatible provider.
 *
 * Starts the API server, creates a provider profile from env vars, then runs a
 * conversation over the WebSocket protocol while emulating the browser preview
 * so all client-side scene tools round-trip. Always exits, even on timeout.
 *
 * Env:
 *   LIVE_API_KEY   (required)
 *   LIVE_BASE_URL  (default https://api.deepseek.com/v1)
 *   LIVE_MODEL     (required)
 *   LIVE_STEPS     max agent steps (default 10)
 *   LIVE_TIMEOUT_MS hard timeout (default 240000)
 *   LIVE_PORT      api server port (default 8791)
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockPreview } from './mock-preview.mjs';

const API_KEY = process.env.LIVE_API_KEY;
const BASE_URL = process.env.LIVE_BASE_URL ?? 'https://api.deepseek.com/v1';
const MODEL = process.env.LIVE_MODEL;
const MAX_STEPS = Number(process.env.LIVE_STEPS ?? 10);
const TIMEOUT_MS = Number(process.env.LIVE_TIMEOUT_MS ?? 240_000);
const PORT = Number(process.env.LIVE_PORT ?? 8791);

if (!API_KEY || !MODEL) {
  console.error('LIVE_API_KEY and LIVE_MODEL are required');
  process.exit(1);
}

const workDir = mkdtempSync(join(tmpdir(), 'llm3d-live-'));
const dbPath = join(workDir, 'live.sqlite');
const children = [];
let finished = false;

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

function killTree(pid) {
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    // ignore
  }
}

function cleanup(code) {
  if (finished) return;
  finished = true;
  for (const child of children) killTree(child.pid);
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
  setTimeout(() => process.exit(code), 300);
}

async function waitForHealth(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/api/health`);
      if (response.ok) return;
    } catch {
      // not ready
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error('Server did not become healthy');
}

async function api(path, init) {
  const response = await fetch(`http://127.0.0.1:${PORT}${path}`, {
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
  const hardTimer = setTimeout(() => {
    console.error(`\n[live] TIMEOUT after ${TIMEOUT_MS}ms`);
    cleanup(2);
  }, TIMEOUT_MS);

  console.log(`[live] model=${MODEL} base=${BASE_URL} steps=${MAX_STEPS}`);
  console.log('[live] starting api server…');
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
  console.log('[live] server healthy');

  const project = await api('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name: 'Live Test' }),
  });
  const provider = await api('/api/providers', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Live Provider',
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      defaultModel: MODEL,
    }),
  });
  const conversation = await api(`/api/projects/${project.id}/conversations`, {
    method: 'POST',
    body: JSON.stringify({
      title: '带底座的立柱',
      providerProfileId: provider.id,
      model: MODEL,
      config: { maxSteps: MAX_STEPS, temperature: 0.3, maxOutputTokens: 6000 },
    }),
  });
  console.log(`[live] conversation=${conversation.id}`);

  const preview = createMockPreview();
  const toolCalls = [];
  const operations = [];
  const artifacts = [];
  let completedStatus = null;

  const completed = new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const settleTimer = setTimeout(
      () => reject(new Error('no conversation.turn_finished received')),
      TIMEOUT_MS,
    );
    socket.onopen = () => {
      socket.send(envelope({ type: 'preview.ready', projectId: project.id }));
      socket.send(envelope({ type: 'project.subscribe', projectId: project.id }));
      socket.send(envelope({ type: 'conversation.subscribe', conversationId: conversation.id }));
      socket.send(
        envelope({
          type: 'conversation.start',
          conversationId: conversation.id,
          prompt:
            '用工具创建一个带底座的立柱：一个 1.5m x 0.15m x 1.5m 的木质底座，上面立一根半径 0.12m、高 1.2m 的金属圆柱。请按标准流程：创建、对齐、检查场景、截取等轴测视图确认、导出 GLB，最后 finish。',
        }),
      );
    };
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      switch (message.type) {
        case 'conversation.status':
          console.log(`[live] status -> ${message.status}`);
          break;
        case 'tool.client_request': {
          const name = message.request.name;
          toolCalls.push(name);
          const result = preview.execute(name, message.request.input);
          console.log(`[live] client tool: ${name} -> ${result.success ? 'ok' : result.error}`);
          socket.send(
            envelope({
              type: 'client.tool_result',
              conversationId: conversation.id,
              requestId: message.request.requestId,
              ok: true,
              result,
            }),
          );
          break;
        }
        case 'scene.operation':
          operations.push(message.operation);
          console.log(`[live] op #${message.operation.seq} ${message.operation.tool}`);
          break;
        case 'artifact.created':
          artifacts.push(message.artifact);
          console.log(`[live] artifact ${message.artifact.kind} ${message.artifact.filename}`);
          break;
        case 'error':
          console.error(`[live] error: ${message.message}`);
          break;
        case 'conversation.error':
          console.error(`[live] conversation.error: ${message.message}`);
          break;
        case 'conversation.turn_finished':
          completedStatus = message.status;
          clearTimeout(settleTimer);
          socket.close();
          resolve(message.status);
          break;
        default:
          break;
      }
    };
    socket.onerror = () => reject(new Error('WebSocket error'));
  });

  const status = await completed;
  clearTimeout(hardTimer);

  const snapshot = await api(`/api/conversations/${conversation.id}/snapshot`);
  const storedArtifacts = await api(`/api/projects/${project.id}/artifacts`);

  console.log('\n========== RESULT ==========');
  console.log(`status:       ${status}`);
  console.log(`tools used:   ${toolCalls.join(', ') || 'none'}`);
  console.log(`operations:   ${operations.map((operation) => `#${operation.seq}:${operation.tool}`).join(', ') || 'none'}`);
  console.log(`artifacts:    ${storedArtifacts.map((artifact) => artifact.filename).join(', ') || 'none'}`);
  console.log(
    `usage:        in=${snapshot.usage.inputTokens ?? 0} out=${snapshot.usage.outputTokens ?? 0} reasoning=${snapshot.usage.reasoningTokens ?? 0}`,
  );
  if (operations.length > 0) {
    console.log('---------- last operation ----------');
    const last = operations[operations.length - 1];
    console.log(JSON.stringify({ tool: last.tool, input: last.input, result: last.result }, null, 2).slice(0, 900));
    console.log('------------------------------------');
  }

  const failures = [];
  if (status !== 'idle') failures.push(`status=${status}`);
  if (operations.length < 2) failures.push(`expected >= 2 scene operations, got ${operations.length}`);
  if (!toolCalls.includes('create_primitive')) failures.push('create_primitive was not called');
  if (!toolCalls.includes('export_glb')) failures.push('export_glb was not called');
  if (storedArtifacts.length < 1) failures.push('no artifacts stored');
  const errorItems = snapshot.timeline.filter((item) => item.status === 'error');
  if (errorItems.length > 0) failures.push(`timeline errors: ${errorItems.map((item) => item.title).join(', ')}`);

  if (failures.length > 0) {
    console.error('\n[live] FAILED:');
    for (const failure of failures) console.error(`  - ${failure}`);
    cleanup(1);
    return;
  }
  console.log('\n[live] PASSED');
  cleanup(0);
}

main().catch((error) => {
  console.error('[live] fatal:', error);
  cleanup(1);
});
