import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { ADDITION, Brush, Evaluator, INTERSECTION, SUBTRACTION } from 'three-bvh-csg';
import type {
  AlignObjectInput,
  BooleanMeshInput,
  BoundingBox,
  CaptureMultiviewInput,
  CaptureViewportInput,
  CreateExtrudeMeshInput,
  CreatePrimitiveInput,
  DeleteObjectInput,
  DuplicateObjectInput,
  EvalCodeFallbackInput,
  GroupObjectsInput,
  HostToSandboxMessage,
  InspectSceneInput,
  ModifyMaterialInput,
  PBRMaterialInput,
  SceneInfo,
  SceneNodeInfo,
  SceneStats,
  SandboxToHostMessage,
  SetupLightingInput,
  ToolExecutionResult,
  TransformObjectInput,
  Vec3,
} from '@llm3d/shared';

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

function post(message: SandboxToHostMessage): void {
  window.parent.postMessage(message, '*');
}

function isHostMessage(value: unknown): value is HostToSandboxMessage {
  if (typeof value !== 'object' || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return (
    type === 'reset' ||
    type === 'exec' ||
    type === 'loadScene' ||
    type === 'resize' ||
    type === 'screenshot' ||
    type === 'setCamera' ||
    type === 'exportGlb'
  );
}

const MUTATING_TOOLS = new Set([
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
]);

for (const level of ['log', 'warn', 'error'] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    original(...args);
    try {
      post({
        type: 'console',
        level,
        args: args.map((value) => {
          if (typeof value === 'string') return value.slice(0, 500);
          try {
            const text = JSON.stringify(value);
            return text && text.length > 500 ? `${text.slice(0, 500)}…` : (text ?? String(value));
          } catch {
            return String(value);
          }
        }),
      });
    } catch {
      // ignore
    }
  };
}

// ---------------------------------------------------------------------------
// Renderer / scene bootstrap
// ---------------------------------------------------------------------------

const canvas = document.createElement('canvas');
canvas.style.display = 'block';
canvas.style.width = '100%';
canvas.style.height = '100%';
canvas.style.background = '#101216';
document.body.style.margin = '0';
document.body.style.overflow = 'hidden';
document.body.style.background = '#101216';
document.body.appendChild(canvas);

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

let scene = new THREE.Scene();
let camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
let controls: OrbitControls | null = null;

const objects = new Map<string, THREE.Object3D>();
const idCounters = new Map<string, number>();
let sceneLightTargets: THREE.Object3D[] = [];
let currentLighting: SetupLightingInput = { preset: 'studio_soft' };

class ToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly suggestion?: string,
  ) {
    super(message);
  }
}

function ok(fields: Omit<ToolExecutionResult, 'success'>): ToolExecutionResult {
  return { success: true, ...fields };
}

function fail(error_code: string, error: string, suggestion?: string): ToolExecutionResult {
  return { success: false, error_code, error, suggestion };
}

function toResult(error: unknown): ToolExecutionResult {
  if (error instanceof ToolError) {
    return fail(error.code, error.message, error.suggestion);
  }
  return fail('TOOL_EXECUTION_ERROR', error instanceof Error ? error.message : String(error));
}

// ---------------------------------------------------------------------------
// Object registry / math helpers
// ---------------------------------------------------------------------------

function vec3(value: THREE.Vector3): Vec3 {
  return [
    Number(value.x.toFixed(4)),
    Number(value.y.toFixed(4)),
    Number(value.z.toFixed(4)),
  ];
}

function nextId(prefix: string): string {
  const count = (idCounters.get(prefix) ?? 0) + 1;
  idCounters.set(prefix, count);
  return `${prefix}_${String(count).padStart(3, '0')}`;
}

function uniqueId(base: string): string {
  const sanitized = base.replace(/[^a-zA-Z0-9_-]/g, '_') || 'object';
  let candidate = sanitized;
  let index = 2;
  while (objects.has(candidate)) {
    candidate = `${sanitized}_${index}`;
    index += 1;
  }
  return candidate;
}

function registerObject(object: THREE.Object3D, id: string, explicit = false): string {
  if (explicit) {
    const sanitized = id.replace(/[^a-zA-Z0-9_-]/g, '_') || 'object';
    if (objects.has(sanitized)) {
      throw new ToolError(
        'NAME_TAKEN',
        `Object id "${sanitized}" already exists in the scene.`,
        'Pick a different name, or use transform_object / modify_material / delete_object to change the existing object.',
      );
    }
    objects.set(sanitized, object);
    object.userData.objectId = sanitized;
    if (!object.name || object.name.startsWith('__')) object.name = sanitized;
    return sanitized;
  }
  const finalId = uniqueId(id);
  objects.set(finalId, object);
  object.userData.objectId = finalId;
  if (!object.name || object.name.startsWith('__')) object.name = finalId;
  return finalId;
}

function getObject(id: string): THREE.Object3D {
  const object = objects.get(id);
  if (!object) {
    throw new ToolError(
      'OBJECT_NOT_FOUND',
      `Object "${id}" does not exist in the scene.`,
      'Call inspect_scene to list the current object ids.',
    );
  }
  return object;
}

function toBoundingBox(box: THREE.Box3): BoundingBox {
  if (box.isEmpty()) {
    const origin: Vec3 = [0, 0, 0];
    return { min: origin, max: origin, size: origin, center: origin };
  }
  return {
    min: vec3(box.min),
    max: vec3(box.max),
    size: vec3(box.getSize(new THREE.Vector3())),
    center: vec3(box.getCenter(new THREE.Vector3())),
  };
}

function objectAabb(object: THREE.Object3D): BoundingBox {
  object.updateWorldMatrix(true, true);
  return toBoundingBox(new THREE.Box3().setFromObject(object));
}

function unionAabb(targets: THREE.Object3D[]): BoundingBox | undefined {
  if (targets.length === 0) return undefined;
  const box = new THREE.Box3();
  for (const target of targets) box.union(new THREE.Box3().setFromObject(target));
  return toBoundingBox(box);
}

function disposeObject(object: THREE.Object3D): void {
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(material)) {
      for (const entry of material) entry.dispose();
    } else if (material) {
      material.dispose();
    }
  });
}

function removeObject(id: string): void {
  const object = objects.get(id);
  if (!object) return;
  object.removeFromParent();
  disposeObject(object);
  objects.delete(id);
}

// ---------------------------------------------------------------------------
// Materials & lighting
// ---------------------------------------------------------------------------

function createMaterial(config: PBRMaterialInput | undefined): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color(config?.color ?? '#9aa0a6'),
    roughness: config?.roughness ?? 0.55,
    metalness: config?.metalness ?? 0.05,
  });
  applyMaterialConfig(material, config);
  return material;
}

function applyMaterialConfig(
  material: THREE.Material,
  config: PBRMaterialInput | undefined,
): THREE.Material {
  if (!config) return material;
  const standard = material as THREE.MeshStandardMaterial;
  if (config.color) standard.color = new THREE.Color(config.color);
  if (config.roughness !== undefined) standard.roughness = config.roughness;
  if (config.metalness !== undefined) standard.metalness = config.metalness;
  if (config.wireframe !== undefined) {
    standard.wireframe = config.wireframe;
    standard.userData.wireframe = config.wireframe;
  }
  if (config.transmission !== undefined) {
    (standard as unknown as { transmission: number }).transmission = config.transmission;
    standard.transparent = config.transmission > 0;
  }
  if (config.opacity !== undefined) {
    standard.opacity = config.opacity;
    standard.transparent = config.opacity < 1;
  }
  standard.needsUpdate = true;
  return material;
}

function clearLights(): void {
  for (const light of sceneLightTargets) light.removeFromParent();
  sceneLightTargets = [];
}

function addLight(light: THREE.Light): void {
  scene.add(light);
  sceneLightTargets.push(light);
}

const LIGHTING_PRESETS = {
  studio_soft: { hemi: 1.9, key: 2.4, fill: 0.8, rim: 1.0, sky: 0xffffff, ground: 0x3a3f4b },
  sunlight_harsh: { hemi: 1.1, key: 4.2, fill: 0.25, rim: 0.5, sky: 0xfff4e0, ground: 0x4a4438 },
  warm_interior: { hemi: 1.6, key: 1.9, fill: 1.2, rim: 0.7, sky: 0xffe3bd, ground: 0x3a2f28 },
  cold_minimal: { hemi: 1.3, key: 2.2, fill: 0.4, rim: 1.4, sky: 0xdfe8ff, ground: 0x2c313a },
} as const;

function setupLighting(config: SetupLightingInput): void {
  currentLighting = { ...config };
  const presetName = config.preset ?? 'studio_soft';
  const preset = LIGHTING_PRESETS[presetName] ?? LIGHTING_PRESETS.studio_soft;
  clearLights();

  const hemi = new THREE.HemisphereLight(
    preset.sky,
    preset.ground,
    config.ambient_intensity ?? preset.hemi,
  );
  hemi.name = '__light_hemi';
  addLight(hemi);

  const key = new THREE.DirectionalLight(0xffffff, preset.key);
  key.name = '__light_key';
  key.position.set(...(config.main_light_position ?? [6, 10, 8]));
  key.castShadow = config.cast_shadows ?? true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 80;
  key.shadow.camera.left = -20;
  key.shadow.camera.right = 20;
  key.shadow.camera.top = 20;
  key.shadow.camera.bottom = -20;
  key.shadow.bias = -0.0005;
  addLight(key);

  const fill = new THREE.DirectionalLight(0xbfd4ff, preset.fill);
  fill.name = '__light_fill';
  fill.position.set(-7, 5, 6);
  addLight(fill);

  const rim = new THREE.DirectionalLight(0xffffff, preset.rim);
  rim.name = '__light_rim';
  rim.position.set(-5, 7, -8);
  addLight(rim);
}

function addHelpers(): void {
  const grid = new THREE.GridHelper(20, 20, 0x5b6270, 0x2c313a);
  grid.name = '__grid';
  const gridMaterial = grid.material as THREE.Material;
  gridMaterial.transparent = true;
  gridMaterial.opacity = 0.5;
  scene.add(grid);

  const axes = new THREE.AxesHelper(1.5);
  axes.name = '__axes';
  scene.add(axes);
}

// ---------------------------------------------------------------------------
// Scene lifecycle
// ---------------------------------------------------------------------------

function resetScene(): void {
  for (const object of objects.values()) {
    object.removeFromParent();
    disposeObject(object);
  }
  objects.clear();
  idCounters.clear();
  sceneLightTargets = [];

  scene.traverse((child) => {
    if (child !== scene) {
      const mesh = child as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
    }
  });

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x101216);
  currentLighting = { preset: 'studio_soft' };
  setupLighting(currentLighting);
  addHelpers();

  const width = Math.max(1, window.innerWidth);
  const height = Math.max(1, window.innerHeight);
  camera = new THREE.PerspectiveCamera(45, width / height, 0.01, 1000);
  camera.position.set(4, 3, 6);

  controls?.dispose();
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.target.set(0, 1, 0);
  controls.update();

  renderer.setSize(width, height, false);
}

// ---------------------------------------------------------------------------
// Camera / rendering
// ---------------------------------------------------------------------------

function modelBounds(): THREE.Box3 {
  const box = new THREE.Box3();
  for (const object of objects.values()) box.union(new THREE.Box3().setFromObject(object));
  if (box.isEmpty()) box.set(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 2, 1));
  return box;
}

const VIEW_DIRECTIONS: Record<string, THREE.Vector3> = {
  isometric: new THREE.Vector3(1, 1, 1),
  front: new THREE.Vector3(0, 0.12, 1),
  back: new THREE.Vector3(0, 0.12, -1),
  left: new THREE.Vector3(-1, 0.12, 0),
  right: new THREE.Vector3(1, 0.12, 0),
  side: new THREE.Vector3(1, 0.12, 0),
  top: new THREE.Vector3(0, 1, 0.001),
  bottom: new THREE.Vector3(0, -1, 0.001),
  perspective_detail: new THREE.Vector3(1, 0.55, 1),
  perspective: new THREE.Vector3(1, 0.7, 1),
};

function frameBounds(box: THREE.Box3, view: string, zoom = 1): void {
  if (!controls) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z, 0.2) * 0.5;
  const fov = (camera.fov * Math.PI) / 180;
  const distance = (radius / Math.tan(fov / 2)) * 1.9 * zoom;
  const direction = (VIEW_DIRECTIONS[view] ?? VIEW_DIRECTIONS.perspective).clone().normalize();
  camera.position.copy(center).addScaledVector(direction, distance);
  controls.target.copy(center);
  camera.near = Math.max(0.01, distance / 200);
  camera.far = distance * 200;
  camera.updateProjectionMatrix();
  controls.update();
}

function screenshot(
  view: string | undefined,
  width: number | undefined,
  height: number | undefined,
  maxSize?: number,
): { dataUrl: string; width: number; height: number } {
  if (view && view !== 'current') {
    frameBounds(modelBounds(), view);
  }
  const previousSize = renderer.getSize(new THREE.Vector2());
  const previousAspect = camera.aspect;
  let targetWidth = width ?? previousSize.x;
  let targetHeight = height ?? previousSize.y;
  if (maxSize && !width && !height) {
    const pixelRatio = renderer.getPixelRatio();
    const longest = Math.max(targetWidth, targetHeight) * pixelRatio;
    if (longest > maxSize) {
      const scale = maxSize / longest;
      targetWidth = Math.max(1, Math.round(targetWidth * scale));
      targetHeight = Math.max(1, Math.round(targetHeight * scale));
    }
  }
  const resized = targetWidth !== previousSize.x || targetHeight !== previousSize.y;
  if (resized) {
    renderer.setSize(targetWidth, targetHeight, false);
    camera.aspect = targetWidth / targetHeight;
    camera.updateProjectionMatrix();
  }
  controls?.update();
  renderer.render(scene, camera);
  const dataUrl = renderer.domElement.toDataURL('image/png');
  if (resized) {
    renderer.setSize(previousSize.x, previousSize.y, false);
    camera.aspect = previousAspect;
    camera.updateProjectionMatrix();
  }
  return { dataUrl, width: targetWidth, height: targetHeight };
}

async function exportGlb(): Promise<{
  dataBase64: string;
  size: number;
  lighting: SetupLightingInput;
}> {
  const exporter = new GLTFExporter();
  const removed: Array<{ object: THREE.Object3D; parent: THREE.Object3D }> = [];
  scene.traverse((object) => {
    const isLight = (object as THREE.Light).isLight === true;
    if ((object.name.startsWith('__') || isLight) && object.parent) {
      removed.push({ object, parent: object.parent });
    }
  });
  for (const entry of removed) entry.parent.remove(entry.object);
  try {
    const result = await exporter.parseAsync(scene, { binary: true });
    const bytes = new Uint8Array(result as ArrayBuffer);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return { dataBase64: btoa(binary), size: bytes.byteLength, lighting: currentLighting };
  } finally {
    for (const entry of removed) entry.parent.add(entry.object);
  }
}

function seedIdCounter(id: string): void {
  const match = /^(.+)_(\d+)$/.exec(id);
  if (!match) return;
  const value = Number(match[2]);
  if (!Number.isFinite(value)) return;
  idCounters.set(match[1], Math.max(idCounters.get(match[1]) ?? 0, value));
}

function registerLoadedObject(object: THREE.Object3D): void {
  if ((object as THREE.Light).isLight) return;
  const explicit =
    typeof object.userData.objectId === 'string' ? object.userData.objectId : undefined;
  const fallback = object.name && !object.name.startsWith('__') ? object.name : undefined;
  const id = explicit ?? fallback;
  if (id && !objects.has(id)) {
    objects.set(id, object);
    object.userData.objectId = id;
    if (!object.name) object.name = id;
    seedIdCounter(id);
  }
  const mesh = object as THREE.Mesh;
  if (mesh.isMesh) {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      if (material?.userData?.wireframe) {
        (material as THREE.MeshStandardMaterial).wireframe = true;
      }
    }
  }
  for (const child of [...object.children]) registerLoadedObject(child);
}

async function loadScene(
  message: Extract<HostToSandboxMessage, { type: 'loadScene' }>,
): Promise<number> {
  resetScene();
  if (message.lighting) setupLighting(message.lighting);
  if (!message.dataBase64) {
    postSceneUpdated();
    return 0;
  }
  const bytes = Uint8Array.from(atob(message.dataBase64), (char) => char.charCodeAt(0));
  const gltf = await new GLTFLoader().parseAsync(bytes.buffer, '');
  for (const child of [...gltf.scene.children]) scene.add(child);
  for (const child of [...scene.children]) {
    if (child.name.startsWith('__') || (child as THREE.Light).isLight) continue;
    registerLoadedObject(child);
  }
  if (objects.size > 0) frameBounds(modelBounds(), 'perspective');
  postSceneUpdated();
  return objects.size;
}

function setCamera(message: Extract<HostToSandboxMessage, { type: 'setCamera' }>): void {
  if (!controls) return;
  if (message.preset) frameBounds(modelBounds(), message.preset);
  if (message.frameObject) {
    const object = objects.get(message.frameObject);
    if (!object) throw new ToolError('OBJECT_NOT_FOUND', `Object "${message.frameObject}" not found.`);
    frameBounds(new THREE.Box3().setFromObject(object), 'current');
  }
  if (message.position) camera.position.set(...message.position);
  if (message.target) controls.target.set(...message.target);
  controls.update();
}

// ---------------------------------------------------------------------------
// Scene inspection
// ---------------------------------------------------------------------------

function describeNode(object: THREE.Object3D, includeAabb: boolean): SceneNodeInfo {
  const mesh = object as THREE.Mesh;
  const node: SceneNodeInfo = {
    object_id: (object.userData.objectId as string | undefined) ?? object.name,
    name: object.name,
    type: object.type,
    visible: object.visible,
    position: vec3(object.position),
    rotation: [
      Number(object.rotation.x.toFixed(4)),
      Number(object.rotation.y.toFixed(4)),
      Number(object.rotation.z.toFixed(4)),
    ],
    scale: vec3(object.scale),
  };
  if (mesh.isMesh) {
    const geometry = mesh.geometry;
    const info: Record<string, unknown> = { type: geometry.type };
    const parameters = (geometry as unknown as { parameters?: Record<string, unknown> }).parameters;
    if (parameters) {
      for (const [key, value] of Object.entries(parameters)) {
        if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') {
          info[key] = value;
        }
      }
    }
    const position = geometry.getAttribute('position');
    const index = geometry.getIndex();
    info.triangles = Math.floor((index ? index.count : (position?.count ?? 0)) / 3);
    node.geometry = info;

    const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    const standard = material as THREE.MeshStandardMaterial;
    const materialInfo: Record<string, unknown> = { type: material.type, name: material.name };
    if (standard.color) materialInfo.color = `#${standard.color.getHexString()}`;
    if (typeof standard.roughness === 'number') materialInfo.roughness = standard.roughness;
    if (typeof standard.metalness === 'number') materialInfo.metalness = standard.metalness;
    if (material.transparent) materialInfo.opacity = material.opacity;
    if (standard.wireframe) materialInfo.wireframe = true;
    node.material = materialInfo;
  }
  if (includeAabb) node.aabb = objectAabb(object);
  const children = object.children.filter((child) => !child.name.startsWith('__'));
  if (children.length > 0) {
    node.children = children.slice(0, 200).map((child) => describeNode(child, includeAabb));
  }
  return node;
}

function sceneStats(): SceneStats {
  const stats: SceneStats = { objectCount: 0, meshCount: 0, triangleCount: 0, vertexCount: 0 };
  for (const root of objects.values()) {
    root.traverse((child) => {
      if (child.name.startsWith('__')) return;
      stats.objectCount += 1;
      const mesh = child as THREE.Mesh;
      if (mesh.isMesh) {
        stats.meshCount += 1;
        const position = mesh.geometry.getAttribute('position');
        const index = mesh.geometry.getIndex();
        stats.vertexCount += position?.count ?? 0;
        stats.triangleCount += Math.floor((index ? index.count : (position?.count ?? 0)) / 3);
      }
    });
  }
  return stats;
}

function sceneInfo(): SceneInfo {
  const roots = [...objects.values()].filter((object) => !object.name.startsWith('__'));
  const cameraTarget = controls ? controls.target : new THREE.Vector3();
  return {
    stats: sceneStats(),
    objects: roots.slice(0, 100).map((object) => describeNode(object, true)),
    camera: {
      type: camera.type,
      position: vec3(camera.position),
      target: vec3(cameraTarget),
      fov: camera.fov,
    },
    renderer: {
      width: renderer.domElement.width,
      height: renderer.domElement.height,
      pixelRatio: renderer.getPixelRatio(),
    },
  };
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

function createPrimitive(input: CreatePrimitiveInput): ToolExecutionResult {
  const { dimensions: d } = input;
  let geometry: THREE.BufferGeometry;
  switch (input.primitive_type) {
    case 'box':
      geometry = new THREE.BoxGeometry(
        d.width ?? 1,
        d.height ?? 1,
        d.depth ?? 1,
        d.widthSegments ?? 1,
        d.heightSegments ?? 1,
        1,
      );
      break;
    case 'sphere':
      geometry = new THREE.SphereGeometry(
        d.radius ?? 0.5,
        d.radialSegments ?? 16,
        d.heightSegments ?? 12,
      );
      break;
    case 'cylinder':
      geometry = new THREE.CylinderGeometry(
        d.radiusTop ?? d.radius ?? d.radiusBottom ?? 0.5,
        d.radiusBottom ?? d.radius ?? d.radiusTop ?? 0.5,
        d.height ?? 1,
        d.radialSegments ?? 16,
      );
      break;
    case 'cone':
      geometry = new THREE.ConeGeometry(d.radius ?? 0.5, d.height ?? 1, d.radialSegments ?? 16);
      break;
    case 'torus':
      geometry = new THREE.TorusGeometry(
        d.radius ?? 0.5,
        d.tube ?? 0.15,
        d.heightSegments ?? 12,
        d.radialSegments ?? 24,
      );
      break;
    case 'plane':
      geometry = new THREE.PlaneGeometry(
        d.width ?? 1,
        d.height ?? 1,
        d.widthSegments ?? 1,
        d.heightSegments ?? 1,
      );
      break;
    default:
      return fail('UNSUPPORTED_PRIMITIVE', `Unknown primitive "${String(input.primitive_type)}".`);
  }

  const mesh = new THREE.Mesh(geometry, createMaterial(input.material));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.position.fromArray(input.position ?? [0, 0, 0]);
  const id = registerObject(mesh, input.name ?? nextId(input.primitive_type), Boolean(input.name));
  scene.add(mesh);
  return ok({
    object_id: id,
    aabb: objectAabb(mesh),
    message: `Created ${input.primitive_type} '${id}'.`,
  });
}

function createExtrudeMesh(input: CreateExtrudeMeshInput): ToolExecutionResult {
  const shape = new THREE.Shape();
  input.contour_points.forEach(([x, y], index) => {
    if (index === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  });
  shape.closePath();

  const bevel = input.bevel_enabled ?? true;
  const bevelThickness = input.bevel_thickness ?? 0.01;
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: input.depth,
    bevelEnabled: bevel,
    bevelThickness,
    bevelSize: bevelThickness,
    bevelSegments: 2,
    curveSegments: 12,
  });
  const mesh = new THREE.Mesh(geometry, createMaterial(input.material));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.position.fromArray(input.position ?? [0, 0, 0]);
  const id = registerObject(mesh, input.name ?? nextId('extrude'), Boolean(input.name));
  scene.add(mesh);
  return ok({
    object_id: id,
    aabb: objectAabb(mesh),
    message: `Extruded contour (${input.contour_points.length} points) as '${id}'.`,
  });
}

function booleanMesh(input: BooleanMeshInput): ToolExecutionResult {
  const target = getObject(input.target_id) as THREE.Mesh;
  const operand = getObject(input.operand_id) as THREE.Mesh;
  if (!target.isMesh || !operand.isMesh) {
    throw new ToolError(
      'CSG_REQUIRES_MESH',
      'Both target_id and operand_id must reference mesh objects.',
      'Use inspect_scene to find mesh object ids.',
    );
  }

  target.updateWorldMatrix(true, false);
  operand.updateWorldMatrix(true, false);
  const targetGeometry = target.geometry.clone().applyMatrix4(target.matrixWorld);
  const operandGeometry = operand.geometry.clone().applyMatrix4(operand.matrixWorld);

  const brushA = new Brush(targetGeometry, target.material as THREE.Material);
  const brushB = new Brush(operandGeometry, operand.material as THREE.Material);
  brushA.updateMatrixWorld(true);
  brushB.updateMatrixWorld(true);

  const operation =
    input.operation === 'subtract'
      ? SUBTRACTION
      : input.operation === 'union'
        ? ADDITION
        : INTERSECTION;

  let result: Brush;
  try {
    const evaluator = new Evaluator();
    evaluator.attributes = ['position', 'normal', 'uv'];
    result = evaluator.evaluate(brushA, brushB, operation);
  } catch (error) {
    throw new ToolError(
      'CSG_EVALUATION_FAILED',
      `Boolean ${input.operation} failed: ${error instanceof Error ? error.message : String(error)}`,
      'Inspect the bounding boxes and make sure the operand actually overlaps the target.',
    );
  }

  const position = result.geometry.getAttribute('position');
  if (!position || position.count === 0) {
    throw new ToolError(
      'CSG_EMPTY_GEOMETRY',
      `Boolean ${input.operation} produced an empty mesh.`,
      'Check that the operand intersects the target using inspect_scene AABBs.',
    );
  }

  const targetParent = target.parent ?? scene;
  const targetId = input.target_id;
  const operandId = input.operand_id;
  const keepOperand = input.keep_operand ?? false;

  targetParent.remove(target);
  disposeObject(target);
  if (!keepOperand) {
    operand.removeFromParent();
    disposeObject(operand);
    objects.delete(operandId);
  }

  const mesh = new THREE.Mesh(result.geometry, target.material as THREE.Material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData.objectId = targetId;
  mesh.name = targetId;
  objects.set(targetId, mesh);
  targetParent.add(mesh);

  return ok({
    object_id: targetId,
    affected_ids: keepOperand ? [targetId] : [targetId, operandId],
    aabb: objectAabb(mesh),
    message: `Boolean ${input.operation} applied to '${targetId}'.`,
  });
}

function duplicateObject(input: DuplicateObjectInput): ToolExecutionResult {
  const source = getObject(input.source_id);
  const arrayType = input.array_type ?? 'linear';
  const created: THREE.Object3D[] = [];
  const ids: string[] = [];

  for (let index = 1; index <= input.count; index += 1) {
    const clone = source.clone(true);
    clone.traverse((child) => {
      if (child.name.startsWith('__')) return;
      child.userData = { ...child.userData };
      delete child.userData.objectId;
    });

    if (arrayType === 'linear') {
      const offset = new THREE.Vector3(...(input.linear_offset ?? [1, 0, 0]));
      clone.position.addScaledVector(offset, index);
    } else {
      const center = new THREE.Vector3(...(input.radial_center ?? [0, 0, 0]));
      const axis =
        input.radial_axis === 'X'
          ? new THREE.Vector3(1, 0, 0)
          : input.radial_axis === 'Z'
            ? new THREE.Vector3(0, 0, 1)
            : new THREE.Vector3(0, 1, 0);
      const total = input.total_angle ?? Math.PI * 2;
      const angle = (total / input.count) * index;
      const quaternion = new THREE.Quaternion().setFromAxisAngle(axis, angle);
      const offset = clone.position.clone().sub(center).applyQuaternion(quaternion);
      clone.position.copy(center).add(offset);
      clone.quaternion.premultiply(quaternion);
    }

    const id = registerObject(
      clone,
      `${input.name_prefix ?? input.source_id}_${String(index).padStart(2, '0')}`,
      true,
    );
    scene.add(clone);
    created.push(clone);
    ids.push(id);
  }

  return ok({
    object_id: ids[0],
    affected_ids: ids,
    aabb: unionAabb(created),
    message: `Duplicated '${input.source_id}' ${input.count} time(s) as a ${arrayType} array.`,
  });
}

function transformObject(input: TransformObjectInput): ToolExecutionResult {
  const object = getObject(input.object_id);
  const relative = input.relative ?? false;

  if (input.position) {
    const position = new THREE.Vector3(...input.position);
    if (relative) {
      object.position.add(position);
    } else if (input.space === 'world' && object.parent) {
      object.parent.updateWorldMatrix(true, false);
      object.position.copy(object.parent.worldToLocal(position.clone()));
    } else {
      object.position.copy(position);
    }
  }
  if (input.rotation) {
    if (relative) {
      object.rotation.x += input.rotation[0];
      object.rotation.y += input.rotation[1];
      object.rotation.z += input.rotation[2];
    } else {
      object.rotation.set(input.rotation[0], input.rotation[1], input.rotation[2]);
    }
  }
  if (input.scale) {
    if (relative) object.scale.multiply(new THREE.Vector3(...input.scale));
    else object.scale.set(...input.scale);
  }
  object.updateWorldMatrix(true, true);

  return ok({
    object_id: input.object_id,
    aabb: objectAabb(object),
    message: `Transformed '${input.object_id}'.`,
  });
}

function alignObject(input: AlignObjectInput): ToolExecutionResult {
  const source = getObject(input.source_id);
  const target =
    input.target_id === 'ground'
      ? null
      : getObject(input.target_id);
  const axis = input.axis.toLowerCase() as 'x' | 'y' | 'z';

  const sourceBox = new THREE.Box3().setFromObject(source);
  const targetBox = target
    ? new THREE.Box3().setFromObject(target)
    : new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 0));

  const sourceCenter = sourceBox.getCenter(new THREE.Vector3());
  const targetCenter = targetBox.getCenter(new THREE.Vector3());

  let delta = 0;
  switch (input.alignment) {
    case 'min_to_max':
      delta = targetBox.max[axis] - sourceBox.min[axis];
      break;
    case 'max_to_min':
      delta = targetBox.min[axis] - sourceBox.max[axis];
      break;
    case 'min_to_min':
      delta = targetBox.min[axis] - sourceBox.min[axis];
      break;
    case 'max_to_max':
      delta = targetBox.max[axis] - sourceBox.max[axis];
      break;
    case 'center_to_center':
      delta = targetCenter[axis] - sourceCenter[axis];
      break;
  }
  delta += input.offset ?? 0;

  const worldPosition = new THREE.Vector3();
  source.getWorldPosition(worldPosition);
  worldPosition[axis] += delta;
  if (source.parent) {
    source.parent.updateWorldMatrix(true, false);
    source.parent.worldToLocal(worldPosition);
  }
  source.position.copy(worldPosition);
  source.updateWorldMatrix(true, true);

  return ok({
    object_id: input.source_id,
    aabb: objectAabb(source),
    message: `Aligned '${input.source_id}' to '${input.target_id}' (${input.axis} ${input.alignment}).`,
  });
}

function groupObjects(input: GroupObjectsInput): ToolExecutionResult {
  const members = input.object_ids.map((id) => {
    const member = getObject(id);
    if (member.parent && member.parent !== scene) {
      const parentId = (member.parent.userData.objectId as string | undefined) ?? member.parent.name;
      throw new ToolError(
        'OBJECT_ALREADY_GROUPED',
        `Object "${id}" is already inside group "${parentId}".`,
        'Group the parent group instead, or delete the existing group first.',
      );
    }
    return member;
  });
  const group = new THREE.Group();
  const pivot = input.pivot_position ?? 'bottom_center';
  const box = unionAabb(members);

  if (pivot === 'center' && box) {
    group.position.set(...box.center);
  } else if (pivot === 'bottom_center' && box) {
    group.position.set(box.center[0], box.min[1], box.center[2]);
  } else {
    group.position.set(0, 0, 0);
  }

  const id = registerObject(group, input.group_name ?? nextId('group'), Boolean(input.group_name));
  scene.add(group);
  group.updateWorldMatrix(true, false);
  for (const member of members) {
    group.attach(member);
  }
  group.updateWorldMatrix(true, true);

  return ok({
    object_id: id,
    affected_ids: input.object_ids,
    aabb: objectAabb(group),
    message: `Grouped ${input.object_ids.length} object(s) as '${id}' (pivot: ${pivot}).`,
  });
}

function deleteObject(input: DeleteObjectInput): ToolExecutionResult {
  const object = getObject(input.object_id);
  const removed: string[] = [];
  object.traverse((child) => {
    const id = child.userData.objectId as string | undefined;
    if (id && objects.get(id) === child) {
      objects.delete(id);
      removed.push(id);
    }
  });
  object.removeFromParent();
  disposeObject(object);
  return ok({
    object_id: input.object_id,
    affected_ids: removed,
    message:
      removed.length > 1
        ? `Deleted '${input.object_id}' and ${removed.length - 1} descendant(s).`
        : `Deleted '${input.object_id}'.`,
  });
}

function modifyMaterial(input: ModifyMaterialInput): ToolExecutionResult {
  const object = getObject(input.object_id);
  let count = 0;
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      if (input.properties.transmission !== undefined && !(material instanceof THREE.MeshPhysicalMaterial)) {
        const physical = new THREE.MeshPhysicalMaterial();
        physical.copy(material as THREE.MeshStandardMaterial);
        const index = materials.indexOf(material);
        materials[index] = physical;
        applyMaterialConfig(physical, input.properties);
      } else {
        applyMaterialConfig(material, input.properties);
      }
      count += 1;
    }
    if (Array.isArray(mesh.material)) mesh.material = materials;
  });

  return ok({
    object_id: input.object_id,
    affected_ids: [input.object_id],
    aabb: objectAabb(object),
    message: `Updated ${count} material(s) on '${input.object_id}'.`,
  });
}

function setupLightingTool(input: SetupLightingInput): ToolExecutionResult {
  setupLighting(input);
  return ok({ message: `Lighting set to '${input.preset ?? 'studio_soft'}'.` });
}

function inspectSceneTool(input: InspectSceneInput): ToolExecutionResult {
  const includeAabb = input.include_bounding_boxes ?? true;
  if (input.target_id) {
    const object = getObject(input.target_id);
    return ok({
      object_id: input.target_id,
      data: {
        node: describeNode(object, includeAabb),
        stats: sceneStats(),
        camera: sceneInfo().camera,
      },
      message: `Inspected '${input.target_id}'.`,
    });
  }
  return ok({
    data: sceneInfo(),
    message: `Scene contains ${objects.size} object(s).`,
  });
}

function captureViewport(input: CaptureViewportInput): ToolExecutionResult {
  if (input.focus_target_id) {
    const object = getObject(input.focus_target_id);
    frameBounds(new THREE.Box3().setFromObject(object), input.camera_view, 1);
  } else {
    frameBounds(modelBounds(), input.camera_view, input.camera_view === 'perspective_detail' ? 0.7 : 1);
  }
  const shot = screenshot(undefined, undefined, undefined, 1280);
  return ok({
    data: { dataUrl: shot.dataUrl, width: shot.width, height: shot.height },
    message: `Captured '${input.camera_view}' view.`,
  });
}

function captureMultiview(input: CaptureMultiviewInput): ToolExecutionResult {
  const views =
    input.views && input.views.length > 0 ? input.views : (['front', 'side', 'isometric', 'back'] as const);
  const focus = input.focus_target_id ? getObject(input.focus_target_id) : null;
  const shots: Array<{ view: string; dataUrl: string; width: number; height: number }> = [];
  for (const view of views) {
    if (focus) {
      frameBounds(new THREE.Box3().setFromObject(focus), view, 1);
    } else {
      frameBounds(modelBounds(), view, view === 'perspective_detail' ? 0.7 : 1);
    }
    const shot = screenshot(undefined, undefined, undefined, 1280);
    shots.push({ view, ...shot });
  }
  return ok({
    data: { shots },
    message: `Captured ${shots.length} view(s): ${views.join(', ')}.`,
  });
}

function evalCodeFallback(input: EvalCodeFallbackInput): ToolExecutionResult {
  const group = new THREE.Group();
  group.name = `__fallback_${idCounters.get('fallback') ?? 0}`;
  scene.add(group);
  const before = new Set(objects.keys());

  const register = (object: THREE.Object3D, name?: string): string => {
    if (!(object instanceof THREE.Object3D)) {
      throw new ToolError('EVAL_INVALID_ARGUMENT', 'registerObject(object, name) expects an Object3D.');
    }
    if (object.parent !== scene && object !== group) scene.add(object);
    return registerObject(object, name ?? nextId('object'), Boolean(name));
  };

  try {
    const fn = new Function('THREE', 'scene', 'targetGroup', 'registerObject', `"use strict";\n${input.code}`);
    fn(THREE, scene, group, register);
  } catch (error) {
    group.removeFromParent();
    throw new ToolError(
      'EVAL_CODE_ERROR',
      error instanceof Error ? error.message : String(error),
      'Fix the script and retry, or use the structured modeling tools instead.',
    );
  }

  for (const child of [...scene.children]) {
    if (child.name.startsWith('__')) continue;
    if (!child.userData.objectId) registerObject(child, nextId('object'));
  }

  const created = [...objects.values()].filter((object) => !before.has(object.userData.objectId));
  if (created.length === 0) {
    return fail(
      'EVAL_NO_OBJECTS',
      'The script did not create any scene objects.',
      'Add meshes to `scene` or `targetGroup`, or call registerObject(object, name).',
    );
  }

  return ok({
    object_id: created[0]?.userData.objectId as string | undefined,
    affected_ids: created.map((object) => object.userData.objectId as string),
    aabb: unionAabb(created),
    message: `eval_code_fallback created ${created.length} object(s).`,
  });
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

function executeTool(tool: string, rawInput: unknown): ToolExecutionResult {
  const input = (rawInput ?? {}) as never;
  try {
    switch (tool) {
      case 'create_primitive':
        return createPrimitive(input as CreatePrimitiveInput);
      case 'create_extrude_mesh':
        return createExtrudeMesh(input as CreateExtrudeMeshInput);
      case 'boolean_mesh':
        return booleanMesh(input as BooleanMeshInput);
      case 'duplicate_object':
        return duplicateObject(input as DuplicateObjectInput);
      case 'transform_object':
        return transformObject(input as TransformObjectInput);
      case 'align_object':
        return alignObject(input as AlignObjectInput);
      case 'group_objects':
        return groupObjects(input as GroupObjectsInput);
      case 'delete_object':
        return deleteObject(input as DeleteObjectInput);
      case 'modify_material':
        return modifyMaterial(input as ModifyMaterialInput);
      case 'setup_lighting':
        return setupLightingTool(input as SetupLightingInput);
      case 'inspect_scene':
        return inspectSceneTool(input as InspectSceneInput);
      case 'capture_viewport':
        return captureViewport(input as CaptureViewportInput);
      case 'capture_multiview':
        return captureMultiview(input as CaptureMultiviewInput);
      case 'eval_code_fallback':
        return evalCodeFallback(input as EvalCodeFallbackInput);
      default:
        return fail('UNKNOWN_TOOL', `Unknown scene tool "${tool}".`);
    }
  } catch (error) {
    return toResult(error);
  }
}

function postSceneUpdated(): void {
  controls?.update();
  renderer.render(scene, camera);
  post({ type: 'sceneUpdated', info: sceneInfo() });
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

function handleMessage(data: HostToSandboxMessage): void {
  switch (data.type) {
    case 'reset':
      resetScene();
      postSceneUpdated();
      break;
    case 'exec': {
      const result = executeTool(data.tool, data.input);
      if (result.success && MUTATING_TOOLS.has(data.tool)) postSceneUpdated();
      post({ type: 'toolResult', requestId: data.requestId, result });
      break;
    }
    case 'loadScene': {
      void loadScene(data)
        .then((objectCount) => {
          post({ type: 'loadSceneDone', requestId: data.requestId, ok: true, objectCount });
        })
        .catch((error: unknown) => {
          post({
            type: 'loadSceneDone',
            requestId: data.requestId,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      break;
    }
    case 'resize':
      renderer.setSize(data.width, data.height, false);
      camera.aspect = data.width / Math.max(1, data.height);
      camera.updateProjectionMatrix();
      break;
    case 'screenshot': {
      try {
        const result = screenshot(data.view, data.width, data.height);
        post({
          type: 'screenshotResult',
          requestId: data.requestId,
          dataUrl: result.dataUrl,
          width: result.width,
          height: result.height,
        });
      } catch (error) {
        post({
          type: 'error',
          requestId: data.requestId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      break;
    }
    case 'setCamera': {
      try {
        setCamera(data);
        post({ type: 'cameraResult', requestId: data.requestId, ok: true });
      } catch (error) {
        post({
          type: 'cameraResult',
          requestId: data.requestId,
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      break;
    }
    case 'exportGlb': {
      void exportGlb()
        .then((result) => {
          post({
            type: 'glbResult',
            requestId: data.requestId,
            ok: true,
            dataBase64: result.dataBase64,
            size: result.size,
            lighting: result.lighting,
          });
        })
        .catch((error: unknown) => {
          post({
            type: 'glbResult',
            requestId: data.requestId,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      break;
    }
    default:
      break;
  }
}

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (!isHostMessage(event.data)) return;
  handleMessage(event.data);
});

// ---------------------------------------------------------------------------
// Render loop / heartbeat
// ---------------------------------------------------------------------------

function animate(): void {
  requestAnimationFrame(animate);
  controls?.update();
  renderer.render(scene, camera);
}

setInterval(() => post({ type: 'heartbeat', t: Date.now() }), 500);

window.addEventListener('resize', () => {
  const width = Math.max(1, window.innerWidth);
  const height = Math.max(1, window.innerHeight);
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
});

resetScene();
animate();
post({ type: 'ready' });
