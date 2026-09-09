import { describe, expect, it } from 'vitest';
import {
  createPrimitiveInputSchema,
  isMutatingTool,
  MODELING_TOOL_NAMES,
  type ArtifactRecord,
  type SceneOperation,
  type ToolExecutionResult,
} from '@llm3d/shared';
import { buildTools, type ToolHost } from './index.js';

function createHost(overrides: Partial<ToolHost> = {}): {
  host: ToolHost;
  recorded: string[];
  artifacts: string[];
} {
  const recorded: string[] = [];
  const artifacts: string[] = [];
  const host: ToolHost = {
    conversationId: 'conversation-1',
    projectId: 'project-1',
    isPreviewAttached: () => true,
    requirePreview: () => undefined,
    requestClientTool: async () =>
      ({
        success: true,
        object_id: 'obj',
        aabb: { min: [0, 0, 0], max: [1, 1, 1], size: [1, 1, 1], center: [0.5, 0.5, 0.5] },
        message: 'ok',
      }) satisfies ToolExecutionResult,
    recordOperation: (tool, input, result) => {
      recorded.push(tool);
      return {
        id: 'op',
        projectId: 'project-1',
        conversationId: 'conversation-1',
        seq: 1,
        tool,
        input,
        result,
        createdAt: 0,
      } satisfies SceneOperation;
    },
    saveArtifact: (input) => {
      artifacts.push(input.filename);
      return {
        id: 'artifact',
        projectId: 'project-1',
        conversationId: 'conversation-1',
        kind: input.kind,
        filename: input.filename,
        mime: input.mime,
        size: input.data.byteLength,
        meta: input.meta ?? {},
        createdAt: 0,
      } satisfies ArtifactRecord;
    },
    toolStarted: () => undefined,
    toolFinished: () => undefined,
    finishTurn: () => undefined,
    ...overrides,
  };
  return { host, recorded, artifacts };
}

// The AI SDK Tool type does not expose a stable execute signature for tests.
type ExecutableTool = {
  execute: (input: unknown, options: { toolCallId: string }) => Promise<unknown>;
};

function asExecutable(tool: unknown): ExecutableTool {
  return tool as ExecutableTool;
}

describe('buildTools', () => {
  it('exposes the RFC-002 modeling tools plus export_glb and finish', () => {
    const { host } = createHost();
    const tools = buildTools(host);
    for (const name of MODELING_TOOL_NAMES) expect(tools).toHaveProperty(name);
    expect(tools).toHaveProperty('export_glb');
    expect(tools).toHaveProperty('finish');
  });

  it('records mutating tools and ignores read-only tools', async () => {
    const { host, recorded } = createHost();
    const tools = buildTools(host);

    await asExecutable(tools.create_primitive).execute(
      { primitive_type: 'box', dimensions: { width: 1 } },
      { toolCallId: 'call-1' },
    );
    await asExecutable(tools.inspect_scene).execute({}, { toolCallId: 'call-2' });
    await asExecutable(tools.capture_viewport).execute(
      { camera_view: 'isometric' },
      { toolCallId: 'call-3' },
    );

    expect(recorded).toEqual(['create_primitive']);
  });

  it('saves a screenshot artifact for capture_viewport', async () => {
    const png = Buffer.from('fake-png').toString('base64');
    const { host, artifacts } = createHost({
      requestClientTool: async () =>
        ({
          success: true,
          data: { dataUrl: `data:image/png;base64,${png}`, width: 800, height: 600 },
          message: 'captured',
        }) satisfies ToolExecutionResult,
    });
    const tools = buildTools(host);
    const result = (await asExecutable(tools.capture_viewport).execute(
      { camera_view: 'front' },
      { toolCallId: 'call-1' },
    )) as ToolExecutionResult;

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatch(/\.png$/);
    expect((result.data as { artifactId: string }).artifactId).toBe('artifact');
  });

  it('saves one artifact per capture_multiview shot and attaches every image', async () => {
    const png = Buffer.from('fake-png').toString('base64');
    const { host, artifacts } = createHost({
      requestClientTool: async () =>
        ({
          success: true,
          data: {
            shots: [
              { view: 'front', dataUrl: `data:image/png;base64,${png}`, width: 800, height: 600 },
              { view: 'back', dataUrl: `data:image/png;base64,${png}`, width: 800, height: 600 },
            ],
          },
          message: 'captured',
        }) satisfies ToolExecutionResult,
    });
    const tools = buildTools(host);
    const result = (await asExecutable(tools.capture_multiview).execute(
      {},
      { toolCallId: 'call-1' },
    )) as ToolExecutionResult;

    expect(artifacts).toHaveLength(2);
    expect(
      (result.data as { shots: Array<{ view: string }> }).shots.map((shot) => shot.view),
    ).toEqual(['front', 'back']);

    const modelOutput = (
      tools.capture_multiview as unknown as {
        toModelOutput: (input: { output: ToolExecutionResult }) => {
          type: string;
          value: Array<{ type: string }>;
        };
      }
    ).toModelOutput({ output: result });
    expect(modelOutput.type).toBe('content');
    expect(modelOutput.value.filter((part) => part.type === 'file')).toHaveLength(2);
  });

  it('does not record a failed mutating tool', async () => {
    const { host, recorded } = createHost({
      requestClientTool: async () =>
        ({ success: false, error_code: 'OBJECT_NOT_FOUND', error: 'missing' }) satisfies ToolExecutionResult,
    });
    const tools = buildTools(host);
    await asExecutable(tools.transform_object).execute(
      { object_id: 'nope', position: [1, 0, 0] },
      { toolCallId: 'call-1' },
    );
    expect(recorded).toEqual([]);
  });

  it('records delete_object as a mutating tool', async () => {
    const { host, recorded } = createHost();
    const tools = buildTools(host);
    await asExecutable(tools.delete_object).execute(
      { object_id: 'obj' },
      { toolCallId: 'call-1' },
    );
    expect(recorded).toEqual(['delete_object']);
  });
});

describe('tool schemas', () => {
  it('classifies mutating tools', () => {
    for (const name of [
      'create_primitive',
      'boolean_mesh',
      'align_object',
      'delete_object',
      'setup_lighting',
    ]) {
      expect(isMutatingTool(name)).toBe(true);
    }
    for (const name of ['inspect_scene', 'capture_viewport', 'export_glb', 'finish']) {
      expect(isMutatingTool(name)).toBe(false);
    }
  });

  it('validates primitive input', () => {
    expect(
      createPrimitiveInputSchema.safeParse({
        primitive_type: 'box',
        dimensions: { width: 1, height: 2, depth: 3 },
      }).success,
    ).toBe(true);
    expect(
      createPrimitiveInputSchema.safeParse({ primitive_type: 'pyramid', dimensions: {} }).success,
    ).toBe(false);
  });
});
