/**
 * In-memory mock of the browser preview sandbox used by smoke/live tests.
 * It implements just enough of the RFC-002 tool surface to let an agent loop
 * run end-to-end without a real browser.
 */
export const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function vec3(value) {
  return value.map((entry) => Number(entry.toFixed(4)));
}

function aabbFor(center = [0, 0, 0], size = [1, 1, 1]) {
  const min = vec3([center[0] - size[0] / 2, center[1] - size[1] / 2, center[2] - size[2] / 2]);
  const max = vec3([center[0] + size[0] / 2, center[1] + size[1] / 2, center[2] + size[2] / 2]);
  return { min, max, size: vec3(size), center: vec3(center) };
}

function sizeForPrimitive(type, dimensions = {}) {
  switch (type) {
    case 'box':
      return [dimensions.width ?? 1, dimensions.height ?? 1, dimensions.depth ?? 1];
    case 'sphere':
      return [
        (dimensions.radius ?? 0.5) * 2,
        (dimensions.radius ?? 0.5) * 2,
        (dimensions.radius ?? 0.5) * 2,
      ];
    case 'cylinder':
    case 'cone':
      return [
        (dimensions.radius ?? dimensions.radiusBottom ?? 0.5) * 2,
        dimensions.height ?? 1,
        (dimensions.radius ?? dimensions.radiusBottom ?? 0.5) * 2,
      ];
    case 'torus':
      return [
        ((dimensions.radius ?? 0.5) + (dimensions.tube ?? 0.15)) * 2,
        ((dimensions.radius ?? 0.5) + (dimensions.tube ?? 0.15)) * 2,
        (dimensions.tube ?? 0.15) * 2,
      ];
    case 'plane':
      return [dimensions.width ?? 1, dimensions.height ?? 1, 0.01];
    default:
      return [1, 1, 1];
  }
}

export function createMockPreview() {
  const objects = new Map();
  let counter = 0;

  const nextId = (prefix) => `${prefix}_${String((counter += 1)).padStart(3, '0')}`;
  const store = (id, aabb, name) => {
    objects.set(id, { id, name: name ?? id, aabb });
    return id;
  };

  function execute(name, input = {}) {
    switch (name) {
      case 'create_primitive': {
        const id = input.name ?? nextId(input.primitive_type ?? 'object');
        const aabb = aabbFor(input.position ?? [0, 0, 0], sizeForPrimitive(input.primitive_type, input.dimensions));
        store(id, aabb);
        return { success: true, object_id: id, aabb, message: `Created ${input.primitive_type} '${id}'.` };
      }
      case 'create_extrude_mesh': {
        const id = input.name ?? nextId('extrude');
        const depth = input.depth ?? 1;
        const aabb = aabbFor(input.position ?? [0, 0, 0], [1, 1, depth]);
        store(id, aabb);
        return { success: true, object_id: id, aabb, message: `Extruded '${id}'.` };
      }
      case 'boolean_mesh': {
        const target = objects.get(input.target_id);
        if (!target) {
          return { success: false, error_code: 'OBJECT_NOT_FOUND', error: `No object '${input.target_id}'.` };
        }
        if (!input.keep_operand) objects.delete(input.operand_id);
        return {
          success: true,
          object_id: input.target_id,
          affected_ids: [input.target_id],
          aabb: target.aabb,
          message: `Boolean ${input.operation} applied to '${input.target_id}'.`,
        };
      }
      case 'duplicate_object': {
        const source = objects.get(input.source_id);
        if (!source) {
          return { success: false, error_code: 'OBJECT_NOT_FOUND', error: `No object '${input.source_id}'.` };
        }
        const ids = [];
        for (let i = 1; i <= (input.count ?? 1); i += 1) {
          const id = `${input.name_prefix ?? input.source_id}_${String(i).padStart(2, '0')}`;
          store(id, source.aabb);
          ids.push(id);
        }
        return { success: true, object_id: ids[0], affected_ids: ids, aabb: source.aabb, message: `Duplicated ${ids.length} copy(ies).` };
      }
      case 'transform_object': {
        const object = objects.get(input.object_id);
        if (!object) {
          return { success: false, error_code: 'OBJECT_NOT_FOUND', error: `No object '${input.object_id}'.` };
        }
        if (input.position) {
          const delta = vec3(input.position).map((entry, index) => entry - object.aabb.center[index]);
          object.aabb = aabbFor(input.position, object.aabb.size);
          void delta;
        }
        return { success: true, object_id: input.object_id, aabb: object.aabb, message: `Transformed '${input.object_id}'.` };
      }
      case 'align_object': {
        const source = objects.get(input.source_id);
        if (!source) {
          return { success: false, error_code: 'OBJECT_NOT_FOUND', error: `No object '${input.source_id}'.` };
        }
        const axisIndex = { X: 0, Y: 1, Z: 2 }[input.axis] ?? 1;
        const target = input.target_id === 'ground' ? null : objects.get(input.target_id);
        if (input.target_id !== 'ground' && !target) {
          return { success: false, error_code: 'OBJECT_NOT_FOUND', error: `No target '${input.target_id}'.` };
        }
        const center = [...source.aabb.center];
        const size = [...source.aabb.size];
        if (input.alignment === 'min_to_max' || input.alignment === 'min_to_min') {
          const targetMin = target ? target.aabb.min[axisIndex] : 0;
          center[axisIndex] = targetMin + size[axisIndex] / 2 + (input.offset ?? 0);
        } else if (input.alignment === 'center_to_center') {
          center[axisIndex] = target ? target.aabb.center[axisIndex] : 0;
        }
        source.aabb = aabbFor(center, size);
        return { success: true, object_id: input.source_id, aabb: source.aabb, message: `Aligned '${input.source_id}'.` };
      }
      case 'group_objects': {
        const id = input.group_name ?? nextId('group');
        const members = input.object_ids.map((memberId) => objects.get(memberId)).filter(Boolean);
        const aabb = members[0]?.aabb ?? aabbFor([0, 0, 0], [1, 1, 1]);
        store(id, aabb);
        return { success: true, object_id: id, affected_ids: input.object_ids, aabb, message: `Grouped as '${id}'.` };
      }
      case 'delete_object': {
        const object = objects.get(input.object_id);
        if (!object) {
          return { success: false, error_code: 'OBJECT_NOT_FOUND', error: `No object '${input.object_id}'.` };
        }
        objects.delete(input.object_id);
        return {
          success: true,
          object_id: input.object_id,
          affected_ids: [input.object_id],
          message: `Deleted '${input.object_id}'.`,
        };
      }
      case 'modify_material': {
        const object = objects.get(input.object_id);
        if (!object) {
          return { success: false, error_code: 'OBJECT_NOT_FOUND', error: `No object '${input.object_id}'.` };
        }
        return { success: true, object_id: input.object_id, affected_ids: [input.object_id], aabb: object.aabb, message: 'Material updated.' };
      }
      case 'setup_lighting':
        return { success: true, message: `Lighting preset '${input.preset ?? 'studio_soft'}' applied.` };
      case 'inspect_scene': {
        const list = input.target_id ? [objects.get(input.target_id)].filter(Boolean) : [...objects.values()];
        return {
          success: true,
          data: {
            stats: { objectCount: list.length, meshCount: list.length, triangleCount: list.length * 12, vertexCount: list.length * 24 },
            objects: list.map((object) => ({
              object_id: object.id,
              name: object.name,
              type: 'Mesh',
              visible: true,
              position: object.aabb.center,
              rotation: [0, 0, 0],
              scale: [1, 1, 1],
              aabb: object.aabb,
            })),
            camera: { type: 'PerspectiveCamera', position: [4, 3, 6], target: [0, 1, 0], fov: 45 },
            renderer: { width: 800, height: 600, pixelRatio: 1 },
          },
          message: `Inspected ${list.length} object(s).`,
        };
      }
      case 'capture_viewport':
        return {
          success: true,
          data: { dataUrl: `data:image/png;base64,${PNG_1PX}`, width: 800, height: 600 },
          message: `Captured '${input.camera_view}'.`,
        };
      case 'capture_multiview': {
        const views = input.views ?? ['front', 'side', 'isometric', 'back'];
        const shots = views.map((view) => ({
          view,
          dataUrl: `data:image/png;base64,${PNG_1PX}`,
          width: 800,
          height: 600,
        }));
        return { success: true, data: { shots }, message: `Captured ${shots.length} view(s).` };
      }
      case 'eval_code_fallback': {
        const id = nextId('fallback');
        const aabb = aabbFor([0, 0, 0], [1, 1, 1]);
        store(id, aabb);
        return { success: true, object_id: id, affected_ids: [id], aabb, message: 'Fallback code created 1 object.' };
      }
      case 'export_glb':
        return {
          success: true,
          data: { dataBase64: Buffer.from('glTFmock').toString('base64'), size: 8 },
          message: `Exported ${input.filename ?? 'model.glb'}.`,
        };
      default:
        return { success: false, error_code: 'UNKNOWN_TOOL', error: `Unknown tool '${name}'.` };
    }
  }

  return { execute, objects };
}
