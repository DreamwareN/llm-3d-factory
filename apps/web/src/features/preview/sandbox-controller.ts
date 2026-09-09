import type {
  CameraPreset,
  SandboxToHostMessage,
  SceneInfo,
  SetupLightingInput,
  ToolExecutionResult,
} from '@llm3d/shared';

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: number;
}

const REQUEST_TIMEOUT_MS = 45_000;
const HEARTBEAT_TIMEOUT_MS = 15_000;

export interface ScreenshotInput {
  view?: CameraPreset;
  width?: number;
  height?: number;
}

type RequestPayload =
  | { type: 'exec'; tool: string; input: unknown }
  | { type: 'loadScene'; dataBase64?: string; lighting?: SetupLightingInput }
  | { type: 'screenshot'; view?: CameraPreset; width?: number; height?: number }
  | {
      type: 'setCamera';
      preset?: CameraPreset;
      position?: [number, number, number];
      target?: [number, number, number];
      frameObject?: string;
    }
  | { type: 'exportGlb' };

export class SandboxController {
  private iframe: HTMLIFrameElement | null = null;
  private projectId: string | null = null;
  private ready = false;
  private readyWaiters: Array<() => void> = [];
  private readonly pending = new Map<string, PendingRequest>();
  private readonly eventHandlers = new Set<(message: SandboxToHostMessage) => void>();
  private lastHeartbeat = 0;
  private watchdog: number | null = null;
  private busy = 0;

  onStalled: (() => void) | null = null;

  constructor() {
    window.addEventListener('message', (event) => this.handleWindowMessage(event));
  }

  get attachedProjectId(): string | null {
    return this.projectId;
  }

  get isReady(): boolean {
    return this.ready;
  }

  attach(iframe: HTMLIFrameElement, projectId: string): void {
    if (this.iframe === iframe && this.projectId === projectId) return;
    if (this.iframe === iframe) {
      // Re-attaching the same live sandbox to another project: keep the loaded
      // runtime (and its `ready` state) so switching projects does not reload
      // the iframe. whenReady() resolves immediately and replay() resets +
      // rebuilds the new project's scene.
      this.rejectPending('Preview switched to another project.');
      this.readyWaiters = [];
      this.projectId = projectId;
      this.lastHeartbeat = Date.now();
      if (this.watchdog === null) this.startWatchdog();
      return;
    }
    this.detach();
    this.iframe = iframe;
    this.projectId = projectId;
    this.ready = false;
    this.lastHeartbeat = Date.now();
    this.startWatchdog();
  }

  detach(): void {
    if (this.watchdog !== null) {
      window.clearInterval(this.watchdog);
      this.watchdog = null;
    }
    this.rejectPending('Preview was detached.');
    this.readyWaiters = [];
    this.iframe = null;
    this.projectId = null;
    this.ready = false;
  }

  private rejectPending(reason: string): void {
    for (const entry of this.pending.values()) {
      window.clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    this.pending.clear();
  }

  onEvent(handler: (message: SandboxToHostMessage) => void): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  whenReady(): Promise<void> {
    if (this.ready) return Promise.resolve();
    return new Promise((resolve) => {
      this.readyWaiters.push(resolve);
    });
  }

  async loadScene(input: {
    dataBase64?: string;
    lighting?: SetupLightingInput;
  }): Promise<{ objectCount: number }> {
    await this.whenReady();
    return (await this.request({ type: 'loadScene', ...input })) as { objectCount: number };
  }

  async executeTool(tool: string, input: unknown): Promise<ToolExecutionResult> {
    await this.whenReady();
    if (tool === 'export_glb') {
      // export_glb is an async host-side export (GLTFExporter), not a sync
      // sandbox tool; the plain `exec` path would report UNKNOWN_TOOL.
      const requested = (input as { filename?: string } | undefined)?.filename;
      const result = await this.exportGlb();
      return {
        success: true,
        message: `Exported ${requested ?? 'model.glb'} (${result.size} bytes).`,
        data: { dataBase64: result.dataBase64, size: result.size },
      };
    }
    return (await this.request({ type: 'exec', tool, input })) as ToolExecutionResult;
  }

  async screenshot(input: ScreenshotInput): Promise<{
    dataUrl: string;
    width: number;
    height: number;
  }> {
    return (await this.request({ type: 'screenshot', ...input })) as {
      dataUrl: string;
      width: number;
      height: number;
    };
  }

  async setCamera(input: {
    preset?: CameraPreset;
    position?: [number, number, number];
    target?: [number, number, number];
    frameObject?: string;
  }): Promise<{ ok: boolean }> {
    await this.request({ type: 'setCamera', ...input });
    return { ok: true };
  }

  async exportGlb(): Promise<{
    dataBase64: string;
    size: number;
    lighting?: SetupLightingInput;
  }> {
    return (await this.request({ type: 'exportGlb' })) as {
      dataBase64: string;
      size: number;
      lighting?: SetupLightingInput;
    };
  }

  getSceneInfo(): SceneInfo | null {
    return this.lastSceneInfo;
  }

  private lastSceneInfo: SceneInfo | null = null;

  private post(message: unknown): void {
    this.iframe?.contentWindow?.postMessage(message, '*');
  }

  private request(payload: RequestPayload): Promise<unknown> {
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const release = (): void => {
        this.busy = Math.max(0, this.busy - 1);
      };
      const timer = window.setTimeout(() => {
        this.pending.delete(requestId);
        release();
        reject(new Error(`Preview request "${payload.type}" timed out.`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(requestId, {
        resolve: (value) => {
          release();
          resolve(value);
        },
        reject: (error) => {
          release();
          reject(error);
        },
        timer,
      });
      this.busy += 1;
      this.post({ ...payload, requestId });
    });
  }

  private handleWindowMessage(event: MessageEvent<unknown>): void {
    if (!this.iframe || event.source !== this.iframe.contentWindow) return;
    const message = event.data as SandboxToHostMessage | null;
    if (!message || typeof message !== 'object' || typeof message.type !== 'string') return;

    const settle = (requestId: string, value: unknown, error?: string): void => {
      const entry = this.pending.get(requestId);
      if (!entry) return;
      window.clearTimeout(entry.timer);
      this.pending.delete(requestId);
      if (error) entry.reject(new Error(error));
      else entry.resolve(value);
    };

    switch (message.type) {
      case 'heartbeat':
        this.lastHeartbeat = Date.now();
        return;
      case 'console':
        break;
      case 'ready':
        this.ready = true;
        this.lastHeartbeat = Date.now();
        for (const resolve of this.readyWaiters.splice(0)) resolve();
        break;
      case 'sceneUpdated':
        this.lastSceneInfo = message.info;
        break;
      case 'toolResult':
        settle(message.requestId, message.result);
        break;
      case 'loadSceneDone':
        if (message.ok) settle(message.requestId, { objectCount: message.objectCount ?? 0 });
        else settle(message.requestId, undefined, message.error ?? 'Scene load failed.');
        break;
      case 'screenshotResult':
        settle(message.requestId, {
          dataUrl: message.dataUrl,
          width: message.width,
          height: message.height,
        });
        break;
      case 'cameraResult':
        if (message.ok) settle(message.requestId, { ok: true });
        else settle(message.requestId, undefined, message.message ?? 'Camera update failed.');
        break;
      case 'glbResult':
        if (message.ok && message.dataBase64) {
          settle(message.requestId, {
            dataBase64: message.dataBase64,
            size: message.size ?? 0,
            ...(message.lighting ? { lighting: message.lighting } : {}),
          });
        } else {
          settle(message.requestId, undefined, message.error ?? 'GLB export failed.');
        }
        break;
      case 'error':
        if (message.requestId) settle(message.requestId, undefined, message.message);
        break;
      default:
        break;
    }

    for (const handler of this.eventHandlers) handler(message);
  }

  private startWatchdog(): void {
    this.watchdog = window.setInterval(() => {
      if (!this.iframe) return;
      // A hidden preview (inactive tab -> display:none) has its timers throttled
      // and its rAF paused; never treat that as a stall or we would reload it.
      const hidden = this.iframe.offsetParent === null || this.iframe.clientWidth === 0;
      if (hidden) {
        this.lastHeartbeat = Date.now();
        return;
      }
      // A request in flight means the sandbox main thread is busy (e.g. a
      // synchronous screenshot readback); reloading now would make it worse.
      if (this.busy > 0) {
        this.lastHeartbeat = Date.now();
        return;
      }
      if (Date.now() - this.lastHeartbeat > HEARTBEAT_TIMEOUT_MS) {
        this.lastHeartbeat = Date.now();
        this.onStalled?.();
      }
    }, 1000);
  }
}

export const sandbox = new SandboxController();

export function buildSandboxDocument(): string {
  const origin = window.location.origin;
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; script-src ${origin}; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; worker-src 'none'; font-src 'none'"
    />
    <style>html,body{margin:0;height:100%;overflow:hidden;background:#101216}</style>
  </head>
  <body>
    <script src="${origin}/sandbox/runtime.js"></script>
  </body>
</html>`;
}
