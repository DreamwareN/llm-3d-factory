export const MODELING_TOOL_NAMES = [
  'create_primitive',
  'create_extrude_mesh',
  'boolean_mesh',
  'duplicate_object',
  'transform_object',
  'align_object',
  'group_objects',
  'delete_object',
  'modify_material',
  'setup_lighting',
  'inspect_scene',
  'capture_viewport',
  'capture_multiview',
  'eval_code_fallback',
] as const;

export const CONTROL_TOOL_NAMES = ['export_glb', 'finish'] as const;

export const CLIENT_TOOL_NAMES = [...MODELING_TOOL_NAMES, 'export_glb'] as const;

export type ModelingToolName = (typeof MODELING_TOOL_NAMES)[number];
export type ClientToolName = (typeof CLIENT_TOOL_NAMES)[number];
export type ControlToolName = (typeof CONTROL_TOOL_NAMES)[number];

/** Tools whose successful calls are written to the project's scene audit log. */
export const MUTATING_TOOL_NAMES: readonly string[] = [
  'create_primitive',
  'create_extrude_mesh',
  'boolean_mesh',
  'duplicate_object',
  'transform_object',
  'align_object',
  'group_objects',
  'delete_object',
  'modify_material',
  'setup_lighting',
  'eval_code_fallback',
];

export function isMutatingTool(name: string): boolean {
  return MUTATING_TOOL_NAMES.includes(name);
}
