import type { SceneInfo, ToolExecutionResult } from './domain.js';
import type { CameraPreset, SetupLightingInput } from './tools.js';

export const SANDBOX_PROTOCOL_VERSION = 4;

export interface SandboxResetMessage {
  type: 'reset';
}

export interface SandboxExecMessage {
  type: 'exec';
  requestId: string;
  tool: string;
  input: unknown;
}

export interface SandboxLoadSceneMessage {
  type: 'loadScene';
  requestId: string;
  dataBase64?: string;
  lighting?: SetupLightingInput;
}

export interface SandboxResizeMessage {
  type: 'resize';
  width: number;
  height: number;
}

export interface SandboxScreenshotMessage {
  type: 'screenshot';
  requestId: string;
  view?: CameraPreset;
  width?: number;
  height?: number;
}

export interface SandboxSetCameraMessage {
  type: 'setCamera';
  requestId: string;
  preset?: CameraPreset;
  position?: [number, number, number];
  target?: [number, number, number];
  frameObject?: string;
}

export interface SandboxExportGlbMessage {
  type: 'exportGlb';
  requestId: string;
}

export type HostToSandboxMessage =
  | SandboxResetMessage
  | SandboxExecMessage
  | SandboxLoadSceneMessage
  | SandboxResizeMessage
  | SandboxScreenshotMessage
  | SandboxSetCameraMessage
  | SandboxExportGlbMessage;

export type SandboxToHostMessage =
  | { type: 'ready' }
  | { type: 'toolResult'; requestId: string; result: ToolExecutionResult }
  | {
      type: 'loadSceneDone';
      requestId: string;
      ok: boolean;
      objectCount?: number;
      error?: string;
    }
  | { type: 'sceneUpdated'; info: SceneInfo }
  | { type: 'heartbeat'; t: number }
  | { type: 'console'; level: 'log' | 'warn' | 'error'; args: string[] }
  | { type: 'screenshotResult'; requestId: string; dataUrl: string; width: number; height: number }
  | { type: 'cameraResult'; requestId: string; ok: boolean; message?: string }
  | {
      type: 'glbResult';
      requestId: string;
      ok: boolean;
      dataBase64?: string;
      size?: number;
      lighting?: SetupLightingInput;
      error?: string;
    }
  | { type: 'error'; requestId?: string; message: string };

export function isHostToSandboxMessage(value: unknown): value is HostToSandboxMessage {
  if (typeof value !== 'object' || value === null) return false;
  const t = (value as { type?: unknown }).type;
  return (
    t === 'reset' ||
    t === 'exec' ||
    t === 'loadScene' ||
    t === 'resize' ||
    t === 'screenshot' ||
    t === 'setCamera' ||
    t === 'exportGlb'
  );
}
