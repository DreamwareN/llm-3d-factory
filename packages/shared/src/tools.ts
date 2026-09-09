import { z } from 'zod';
import { isMutatingTool, type ClientToolName } from './tool-names.js';

export const vec3Schema = z.tuple([z.number(), z.number(), z.number()]);

export const cameraPresetSchema = z.enum([
  'current',
  'front',
  'back',
  'left',
  'right',
  'top',
  'bottom',
  'perspective',
  'isometric',
]);
export type CameraPreset = z.infer<typeof cameraPresetSchema>;

export const multiviewPresetSchema = z.enum([
  'front',
  'back',
  'left',
  'right',
  'side',
  'top',
  'bottom',
  'isometric',
  'perspective',
  'perspective_detail',
]);
export type MultiviewPreset = z.infer<typeof multiviewPresetSchema>;

export const pbrMaterialSchema = z.object({
  color: z.string().optional().describe('Hex color, e.g. "#3b82f6".'),
  roughness: z.number().min(0).max(1).optional(),
  metalness: z.number().min(0).max(1).optional(),
  transmission: z.number().min(0).max(1).optional(),
  opacity: z.number().min(0).max(1).optional(),
  wireframe: z.boolean().optional(),
});

export const primitiveTypeSchema = z.enum([
  'box',
  'sphere',
  'cylinder',
  'cone',
  'torus',
  'plane',
]);

export const dimensionsSchema = z.object({
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
  depth: z.number().positive().optional(),
  radius: z.number().positive().optional(),
  radiusTop: z.number().positive().optional(),
  radiusBottom: z.number().positive().optional(),
  tube: z.number().positive().optional(),
  radialSegments: z.number().int().min(3).max(64).optional(),
  widthSegments: z.number().int().min(1).max(64).optional(),
  heightSegments: z.number().int().min(1).max(64).optional(),
});

export const createPrimitiveInputSchema = z.object({
  primitive_type: primitiveTypeSchema,
  dimensions: dimensionsSchema,
  position: vec3Schema.optional().describe('World position [x, y, z] in meters. Default [0,0,0].'),
  material: pbrMaterialSchema.optional(),
  name: z
    .string()
    .optional()
    .describe('Optional stable object id/name. Auto-generated when omitted.'),
});

export const createExtrudeMeshInputSchema = z.object({
  contour_points: z
    .array(z.tuple([z.number(), z.number()]))
    .min(3)
    .describe('Closed 2D contour in the XY plane. Auto-closed.'),
  depth: z.number().positive().describe('Extrusion depth along +Z, in meters.'),
  bevel_enabled: z.boolean().optional(),
  bevel_thickness: z.number().min(0).max(1).optional(),
  position: vec3Schema.optional(),
  material: pbrMaterialSchema.optional(),
  name: z.string().optional(),
});

export const booleanMeshInputSchema = z.object({
  operation: z.enum(['subtract', 'union', 'intersect']),
  target_id: z.string().describe('Id of the main body object.'),
  operand_id: z.string().describe('Id of the tool/operand object.'),
  keep_operand: z.boolean().optional().describe('Keep the operand after the operation. Default false.'),
});

export const duplicateObjectInputSchema = z.object({
  source_id: z.string(),
  count: z.number().int().min(1).max(500),
  array_type: z.enum(['linear', 'radial']).optional(),
  linear_offset: vec3Schema.optional().describe('Per-copy offset for linear arrays.'),
  radial_center: vec3Schema.optional().describe('Rotation center for radial arrays.'),
  radial_axis: z.enum(['X', 'Y', 'Z']).optional(),
  total_angle: z.number().optional().describe('Total arc in radians; 2*PI for a closed ring.'),
  name_prefix: z.string().optional(),
});

export const transformObjectInputSchema = z.object({
  object_id: z.string(),
  position: vec3Schema.optional(),
  rotation: vec3Schema.optional().describe('Euler angles in radians [rx, ry, rz].'),
  scale: vec3Schema.optional(),
  space: z.enum(['world', 'local']).optional(),
  relative: z.boolean().optional().describe('When true, add to the current transform.'),
});

export const alignObjectInputSchema = z.object({
  source_id: z.string(),
  target_id: z.string().describe("Target object id, or 'ground' for the Y=0 plane."),
  axis: z.enum(['X', 'Y', 'Z']),
  alignment: z.enum([
    'min_to_max',
    'max_to_min',
    'center_to_center',
    'min_to_min',
    'max_to_max',
  ]),
  offset: z.number().optional().describe('Fine adjustment along the axis, in meters.'),
});

export const groupObjectsInputSchema = z.object({
  object_ids: z.array(z.string()).min(1),
  group_name: z.string().optional(),
  pivot_position: z.enum(['center', 'bottom_center', 'world_origin']).optional(),
});

export const deleteObjectInputSchema = z.object({
  object_id: z
    .string()
    .describe('Id of the object or group to delete. Groups delete their children too.'),
});

export const modifyMaterialInputSchema = z.object({
  object_id: z.string(),
  properties: pbrMaterialSchema.partial(),
});

export const setupLightingInputSchema = z.object({
  preset: z
    .enum(['studio_soft', 'sunlight_harsh', 'warm_interior', 'cold_minimal'])
    .optional(),
  ambient_intensity: z.number().min(0).max(2).optional(),
  main_light_position: vec3Schema.optional(),
  cast_shadows: z.boolean().optional(),
});

export const inspectSceneInputSchema = z.object({
  target_id: z.string().optional().describe('Inspect only this object and its children.'),
  include_bounding_boxes: z.boolean().optional(),
});

export const captureViewportInputSchema = z.object({
  camera_view: z.enum(['isometric', 'front', 'top', 'side', 'perspective_detail']),
  focus_target_id: z.string().optional(),
});

export const captureMultiviewInputSchema = z.object({
  views: z
    .array(multiviewPresetSchema)
    .min(1)
    .max(8)
    .optional()
    .describe('Camera views to render. Default ["front", "side", "isometric", "back"].'),
  focus_target_id: z
    .string()
    .optional()
    .describe('Frame every view around this object instead of the whole scene.'),
});

export const evalCodeFallbackInputSchema = z.object({
  code: z
    .string()
    .min(1)
    .describe(
      'JavaScript executed with { THREE, scene, targetGroup, registerObject } in scope. ' +
        'Use only when the structured tools cannot express the geometry.',
    ),
  fallback_intent: z.string().optional(),
});

export const exportGlbInputSchema = z.object({
  filename: z.string().optional(),
});

export const finishInputSchema = z.object({
  summary: z.string().min(1).describe('Final summary of the delivered model.'),
});

export type CreatePrimitiveInput = z.infer<typeof createPrimitiveInputSchema>;
export type CreateExtrudeMeshInput = z.infer<typeof createExtrudeMeshInputSchema>;
export type BooleanMeshInput = z.infer<typeof booleanMeshInputSchema>;
export type DuplicateObjectInput = z.infer<typeof duplicateObjectInputSchema>;
export type TransformObjectInput = z.infer<typeof transformObjectInputSchema>;
export type AlignObjectInput = z.infer<typeof alignObjectInputSchema>;
export type GroupObjectsInput = z.infer<typeof groupObjectsInputSchema>;
export type DeleteObjectInput = z.infer<typeof deleteObjectInputSchema>;
export type ModifyMaterialInput = z.infer<typeof modifyMaterialInputSchema>;
export type SetupLightingInput = z.infer<typeof setupLightingInputSchema>;
export type InspectSceneInput = z.infer<typeof inspectSceneInputSchema>;
export type CaptureViewportInput = z.infer<typeof captureViewportInputSchema>;
export type CaptureMultiviewInput = z.infer<typeof captureMultiviewInputSchema>;
export type EvalCodeFallbackInput = z.infer<typeof evalCodeFallbackInputSchema>;
export type ExportGlbInput = z.infer<typeof exportGlbInputSchema>;
export type FinishInput = z.infer<typeof finishInputSchema>;
export type PBRMaterialInput = z.infer<typeof pbrMaterialSchema>;

export {
  CLIENT_TOOL_NAMES,
  CONTROL_TOOL_NAMES,
  MODELING_TOOL_NAMES,
  MUTATING_TOOL_NAMES,
  isMutatingTool,
  type ClientToolName,
  type ControlToolName,
  type ModelingToolName,
} from './tool-names.js';

export const toolInputSchemas = {
  create_primitive: createPrimitiveInputSchema,
  create_extrude_mesh: createExtrudeMeshInputSchema,
  boolean_mesh: booleanMeshInputSchema,
  duplicate_object: duplicateObjectInputSchema,
  transform_object: transformObjectInputSchema,
  align_object: alignObjectInputSchema,
  group_objects: groupObjectsInputSchema,
  delete_object: deleteObjectInputSchema,
  modify_material: modifyMaterialInputSchema,
  setup_lighting: setupLightingInputSchema,
  inspect_scene: inspectSceneInputSchema,
  capture_viewport: captureViewportInputSchema,
  capture_multiview: captureMultiviewInputSchema,
  eval_code_fallback: evalCodeFallbackInputSchema,
  export_glb: exportGlbInputSchema,
  finish: finishInputSchema,
} as const;
