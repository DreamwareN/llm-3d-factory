#!/usr/bin/env node
/**
 * Minimal OpenAI-compatible mock provider used for local demos and smoke tests.
 *
 * It walks a deterministic scene-building sequence using the RFC-002 tools:
 * create base + column, align, inspect, capture, export, finish.
 *
 * Usage: node scripts/fake-provider.mjs [port]
 */
import http from 'node:http';

const port = Number(process.argv[2] ?? process.env.FAKE_PROVIDER_PORT ?? 9999);

const SEQUENCE = [
  {
    name: 'create_primitive',
    args: {
      primitive_type: 'box',
      dimensions: { width: 2, height: 0.2, depth: 2 },
      position: [0, 0.1, 0],
      material: { color: '#8b5a2b', roughness: 0.8 },
      name: 'base',
    },
  },
  {
    name: 'create_primitive',
    args: {
      primitive_type: 'cylinder',
      dimensions: { radiusTop: 0.2, radiusBottom: 0.25, height: 1.2, radialSegments: 12 },
      position: [0, 0.8, 0],
      material: { color: '#4b5563', roughness: 0.4, metalness: 0.6 },
      name: 'column',
    },
  },
  {
    name: 'align_object',
    args: { source_id: 'column', target_id: 'base', axis: 'Y', alignment: 'min_to_max' },
  },
  {
    name: 'capture_viewport',
    args: { camera_view: 'isometric' },
  },
  {
    name: 'export_glb',
    args: { filename: 'demo-scene.glb' },
  },
  {
    name: 'finish',
    args: { summary: 'Demo scene: 2x2m base with a 1.2m column, validated and exported.' },
  },
];

function chunk(delta, finishReason = null) {
  return {
    id: 'chatcmpl-mock',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'mock-model',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function toolCallChunk(id, name, args) {
  return chunk({
    role: 'assistant',
    tool_calls: [
      {
        index: 0,
        id,
        type: 'function',
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  });
}

function sendSse(response, chunks) {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  for (const item of chunks) response.write(`data: ${JSON.stringify(item)}\n\n`);
  response.write('data: [DONE]\n\n');
  response.end();
}

const server = http.createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/v1/models') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ data: [{ id: 'mock-model', object: 'model' }] }));
    return;
  }

  if (request.method !== 'POST' || !request.url?.startsWith('/v1/chat/completions')) {
    response.writeHead(404, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'Not found' } }));
    return;
  }

  let body = '';
  request.on('data', (piece) => {
    body += piece;
  });
  request.on('end', () => {
    let payload = {};
    try {
      payload = JSON.parse(body);
    } catch {
      payload = {};
    }
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    const completedTools = messages.filter((message) => message.role === 'tool').length;
    const step = SEQUENCE[Math.min(completedTools, SEQUENCE.length - 1)];
    const chunks = [
      toolCallChunk(`call_${completedTools}`, step.name, step.args),
      chunk({}, 'tool_calls'),
    ];

    if (payload.stream !== false) {
      sendSse(response, chunks);
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify({
        id: 'chatcmpl-mock',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'mock-model',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: `call_${completedTools}`,
                  type: 'function',
                  function: { name: step.name, arguments: JSON.stringify(step.args) },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }),
    );
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[fake-provider] listening on http://127.0.0.1:${port}/v1`);
});
