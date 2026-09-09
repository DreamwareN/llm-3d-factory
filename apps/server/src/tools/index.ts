import { tool, type Tool, type ToolSet } from 'ai';
import type { z } from 'zod';
import {
  alignObjectInputSchema,
  booleanMeshInputSchema,
  captureMultiviewInputSchema,
  captureViewportInputSchema,
  createExtrudeMeshInputSchema,
  createPrimitiveInputSchema,
  deleteObjectInputSchema,
  duplicateObjectInputSchema,
  evalCodeFallbackInputSchema,
  exportGlbInputSchema,
  finishInputSchema,
  groupObjectsInputSchema,
  inspectSceneInputSchema,
  isMutatingTool,
  modifyMaterialInputSchema,
  setupLightingInputSchema,
  transformObjectInputSchema,
  type ArtifactRecord,
  type ClientToolName,
  type SceneOperation,
  type ToolExecutionResult,
} from '@llm3d/shared';

export interface ToolHost {
  readonly conversationId: string;
  readonly projectId: string;
  isPreviewAttached(): boolean;
  requirePreview(): void;
  requestClientTool(
    name: ClientToolName,
    input: unknown,
    toolCallId: string,
  ): Promise<ToolExecutionResult>;
  recordOperation(tool: string, input: unknown, result: ToolExecutionResult): SceneOperation;
  saveArtifact(input: {
    kind: ArtifactRecord['kind'];
    filename: string;
    mime: string;
    data: Buffer;
    meta?: Record<string, unknown>;
  }): ArtifactRecord;
  toolStarted(callId: string, name: string, input: unknown): void;
  toolFinished(callId: string, ok: boolean, result?: unknown, error?: string): void;
  finishTurn(summary: string): void;
}

type ToolOptions = { toolCallId: string; abortSignal?: AbortSignal };
type ToolResultOutput =
  | { type: 'text'; value: string }
  | {
      type: 'content';
      value: Array<
        | { type: 'text'; text: string }
        | { type: 'file'; mediaType: string; data: { type: 'data'; data: string } }
      >;
    };
type ToolContentValue = Extract<ToolResultOutput, { type: 'content' }>['value'];

function defineTool<R>(
  host: ToolHost,
  name: string,
  definition: {
    description: string;
    inputSchema: z.ZodType;
    execute: (input: never, options: ToolOptions) => Promise<R>;
    toModelOutput?: (output: R) => ToolResultOutput;
  },
): Tool {
  const config: Record<string, unknown> = {
    description: definition.description,
    inputSchema: definition.inputSchema,
    execute: async (input: never, options: ToolOptions): Promise<R> => {
      host.toolStarted(options.toolCallId, name, input);
      try {
        const result = await definition.execute(input, options);
        host.toolFinished(options.toolCallId, true, result);
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        host.toolFinished(options.toolCallId, false, undefined, message);
        throw error;
      }
    },
  };
  if (definition.toModelOutput) {
    const convert = definition.toModelOutput;
    config.toModelOutput = ({ output }: { output: R }) => convert(output);
  }
  return tool(config as never) as Tool;
}

const PREVIEW_NOTE = 'Executed in the live browser preview sandbox.';

function clientTool(
  host: ToolHost,
  name: ClientToolName,
  description: string,
  inputSchema: z.ZodType,
): Tool {
  return defineTool(host, name, {
    description: `${description} ${PREVIEW_NOTE}`,
    inputSchema,
    execute: async (input: never, options) => {
      host.requirePreview();
      const result = await host.requestClientTool(name, input, options.toolCallId);
      if (result.success && isMutatingTool(name)) {
        host.recordOperation(name, input, result);
      }
      return result;
    },
  });
}

export function buildTools(host: ToolHost): ToolSet {
  return {
    // ---- 1. Geometry & mesh -------------------------------------------------
    create_primitive: clientTool(
      host,
      'create_primitive',
      'Create a standard primitive (box, sphere, cylinder, cone, torus, plane) with dimensions, ' +
        'world position and PBR material. Returns object_id and the world AABB.',
      createPrimitiveInputSchema,
    ),

    create_extrude_mesh: clientTool(
      host,
      'create_extrude_mesh',
      'Extrude a closed 2D contour (XY plane) along Z with optional bevel. Use for custom profiles, ' +
        'moldings, arc panels. Returns object_id and AABB.',
      createExtrudeMeshInputSchema,
    ),

    boolean_mesh: clientTool(
      host,
      'boolean_mesh',
      'CSG boolean operation between two meshes: subtract (cut holes), union (merge), intersect ' +
        '(common part). Returns the result object_id and AABB. The operand is destroyed unless keep_operand=true.',
      booleanMeshInputSchema,
    ),

    duplicate_object: clientTool(
      host,
      'duplicate_object',
      'Clone an object into a linear or radial array (columns, stairs, chair rows). ' +
        'Returns affected_ids for every copy.',
      duplicateObjectInputSchema,
    ),

    // ---- 2. Spatial assembly & hierarchy ------------------------------------
    transform_object: clientTool(
      host,
      'transform_object',
      'Apply absolute or relative translation / rotation (radians) / scale to an object in world or ' +
        'local space. Returns the updated AABB.',
      transformObjectInputSchema,
    ),

    align_object: clientTool(
      host,
      'align_object',
      'Semantic AABB alignment: snap, center or stack source against a target object or the ground ' +
        "plane ('ground' = Y 0). Use this instead of guessing coordinates to avoid floating or intersecting parts.",
      alignObjectInputSchema,
    ),

    group_objects: clientTool(
      host,
      'group_objects',
      'Parent several objects under one THREE.Group with a pivot strategy (center, bottom_center, ' +
        'world_origin). Returns the group object_id.',
      groupObjectsInputSchema,
    ),

    delete_object: clientTool(
      host,
      'delete_object',
      'Delete an object or group from the scene (a group deletes its children too). Use when replacing ' +
        'or cleaning up parts instead of leaving them hidden in place.',
      deleteObjectInputSchema,
    ),

    // ---- 3. Appearance ------------------------------------------------------
    modify_material: clientTool(
      host,
      'modify_material',
      'Update PBR material properties (color, roughness, metalness, transmission, opacity, wireframe) ' +
        'of an existing object.',
      modifyMaterialInputSchema,
    ),

    setup_lighting: clientTool(
      host,
      'setup_lighting',
      'Configure scene lighting: a preset (studio_soft, sunlight_harsh, warm_interior, cold_minimal), ' +
        'ambient intensity, main light position and shadow casting.',
      setupLightingInputSchema,
    ),

    // ---- 4. Inspection & fallback -------------------------------------------
    inspect_scene: clientTool(
      host,
      'inspect_scene',
      'Return the scene tree with object ids, world transforms, geometry, materials and exact AABBs. ' +
        'This is the primary way to verify spatial layout and dimensions.',
      inspectSceneInputSchema,
    ),

    capture_viewport: defineTool(host, 'capture_viewport', {
      description:
        'Render the scene from a specific camera view (isometric, front, top, side, perspective_detail) ' +
        `and return the image for visual self-check. ${PREVIEW_NOTE}`,
      inputSchema: captureViewportInputSchema,
      execute: async (input: never, options) => {
        host.requirePreview();
        const result = await host.requestClientTool('capture_viewport', input, options.toolCallId);
        if (!result.success) return result;
        const image = result.data as { dataUrl?: string; width?: number; height?: number } | undefined;
        if (!image?.dataUrl) {
          return {
            success: false,
            error_code: 'INVALID_CLIENT_RESULT',
            error: 'Preview returned no image data for capture_viewport.',
          };
        }
        const width = image.width ?? 0;
        const height = image.height ?? 0;
        const base64 = image.dataUrl.split(',')[1] ?? '';
        const artifact = host.saveArtifact({
          kind: 'png',
          filename: `viewport-${String((input as { camera_view?: string }).camera_view ?? 'view')}-${Date.now()}.png`,
          mime: 'image/png',
          data: Buffer.from(base64, 'base64'),
          meta: { width, height, ...(input as object) },
        });
        return {
          ...result,
          message: `Viewport captured (${width}x${height}).`,
          data: {
            dataUrl: image.dataUrl,
            width,
            height,
            artifactId: artifact.id,
            artifactUrl: `/api/artifacts/${artifact.id}/download`,
          },
        };
      },
      toModelOutput: (output) => {
        const image = output.data as
          | { dataUrl: string; width: number; height: number; artifactId: string }
          | undefined;
        const text = image
          ? `Viewport captured (${image.width}x${image.height}), artifact ${image.artifactId}.`
          : (output.message ?? 'Viewport captured.');
        if (!image) return { type: 'text', value: text };
        return {
          type: 'content',
          value: [
            { type: 'text', text },
            {
              type: 'file',
              mediaType: 'image/png',
              data: { type: 'data', data: image.dataUrl.split(',')[1] ?? '' },
            },
          ],
        };
      },
    }),

    capture_multiview: defineTool(host, 'capture_multiview', {
      description:
        'Render the scene from several camera views at once (default front, side, isometric, back) and ' +
        'return every image in a single result. Use this first to understand an existing model before ' +
        `modifying it, then capture_viewport for close-up checks. ${PREVIEW_NOTE}`,
      inputSchema: captureMultiviewInputSchema,
      execute: async (input: never, options) => {
        host.requirePreview();
        const result = await host.requestClientTool('capture_multiview', input, options.toolCallId);
        if (!result.success) return result;
        const data = result.data as
          | { shots?: Array<{ view?: string; dataUrl?: string; width?: number; height?: number }> }
          | undefined;
        const shots = (data?.shots ?? []).filter((shot) => shot.dataUrl);
        if (shots.length === 0) {
          return {
            success: false,
            error_code: 'INVALID_CLIENT_RESULT',
            error: 'Preview returned no image data for capture_multiview.',
          };
        }
        const saved = shots.map((shot, index) => {
          const view = shot.view ?? `view-${index + 1}`;
          const width = shot.width ?? 0;
          const height = shot.height ?? 0;
          const base64 = (shot.dataUrl ?? '').split(',')[1] ?? '';
          const artifact = host.saveArtifact({
            kind: 'png',
            filename: `viewport-${view}-${Date.now()}-${index + 1}.png`,
            mime: 'image/png',
            data: Buffer.from(base64, 'base64'),
            meta: { width, height, view, ...(input as object) },
          });
          return {
            view,
            width,
            height,
            dataUrl: shot.dataUrl,
            artifactId: artifact.id,
            artifactUrl: `/api/artifacts/${artifact.id}/download`,
          };
        });
        return {
          ...result,
          message: `Captured ${saved.length} view(s): ${saved.map((shot) => shot.view).join(', ')}.`,
          data: { shots: saved },
        };
      },
      toModelOutput: (output) => {
        const shots =
          (output.data as
            | { shots?: Array<{ view: string; dataUrl: string; width: number; height: number }> }
            | undefined)?.shots ?? [];
        if (shots.length === 0) {
          return { type: 'text', value: output.message ?? 'No views captured.' };
        }
        const value: ToolContentValue = [
          {
            type: 'text',
            text: `Captured ${shots.length} view(s): ${shots.map((shot) => shot.view).join(', ')}.`,
          },
        ];
        for (const shot of shots) {
          value.push({ type: 'text', text: `View: ${shot.view} (${shot.width}x${shot.height})` });
          value.push({
            type: 'file',
            mediaType: 'image/png',
            data: { type: 'data', data: shot.dataUrl.split(',')[1] ?? '' },
          });
        }
        return { type: 'content', value };
      },
    }),

    eval_code_fallback: clientTool(
      host,
      'eval_code_fallback',
      'LAST RESORT: execute a raw Three.js snippet with { THREE, scene, targetGroup, registerObject } ' +
        'in scope, for geometry the structured tools cannot express (springs, warped grids, math surfaces). ' +
        'Objects you create must be added to scene or targetGroup and registered via registerObject(object, name) ' +
        'so later tools can reference them.',
      evalCodeFallbackInputSchema,
    ),

    // ---- 5. Delivery --------------------------------------------------------
    export_glb: defineTool(host, 'export_glb', {
      description:
        `Export the current scene to a binary glTF (.glb) artifact for download. ${PREVIEW_NOTE}`,
      inputSchema: exportGlbInputSchema,
      execute: async (input: never, options) => {
        host.requirePreview();
        const result = await host.requestClientTool('export_glb', input, options.toolCallId);
        if (!result.success) return result;
        const data = result.data as { dataBase64?: string; size?: number } | undefined;
        if (!data?.dataBase64) {
          return {
            success: false,
            error_code: 'INVALID_CLIENT_RESULT',
            error: 'Preview returned no GLB data.',
          };
        }
        const requested = (input as { filename?: string }).filename;
        const filename = requested?.endsWith('.glb')
          ? requested
          : `${requested ?? 'model'}.glb`;
        const artifact = host.saveArtifact({
          kind: 'glb',
          filename,
          mime: 'model/gltf-binary',
          data: Buffer.from(data.dataBase64, 'base64'),
          meta: { size: data.size },
        });
        return {
          success: true,
          message: `Exported ${filename} (${artifact.size} bytes).`,
          data: {
            artifactId: artifact.id,
            artifactUrl: `/api/artifacts/${artifact.id}/download`,
            filename,
            size: artifact.size,
          },
        };
      },
      toModelOutput: (output) => ({ type: 'text', value: output.message ?? 'Exported.' }),
    }),

    finish: defineTool(host, 'finish', {
      description:
        'Call when the model is complete and validated. Provide a final summary. This ends the run.',
      inputSchema: finishInputSchema,
      execute: async ({ summary }: z.infer<typeof finishInputSchema>) => {
        host.finishTurn(summary);
        return { success: true, message: 'Task marked complete.' };
      },
    }),
  };
}
