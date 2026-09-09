import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';

loadEnv();

function num(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export interface ServerConfig {
  host: string;
  port: number;
  databasePath: string;
  corsOrigins: string[];
  clientToolTimeoutMs: number;
  maxArtifactBytes: number;
  defaultMaxSteps: number;
  webDistPath: string;
}

export const config: ServerConfig = {
  host: process.env.HOST ?? '127.0.0.1',
  port: num(process.env.PORT, 8787),
  databasePath: resolve(process.cwd(), process.env.DATABASE_PATH ?? './data/llm3d.sqlite'),
  corsOrigins: (process.env.CORS_ORIGIN ?? 'http://localhost:5173')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
  clientToolTimeoutMs: num(process.env.CLIENT_TOOL_TIMEOUT_MS, 60_000),
  maxArtifactBytes: num(process.env.MAX_ARTIFACT_BYTES, 12_000_000),
  defaultMaxSteps: num(process.env.DEFAULT_MAX_STEPS, 24),
  webDistPath: resolve(process.cwd(), '../web/dist'),
};
