import type {
  ArtifactRecord,
  ProjectSceneMeta,
  ProjectSnapshot,
  SceneOperation,
  SetupLightingInput,
  ToolExecutionResult,
} from '@llm3d/shared';
import type { ServerConfig } from '../config.js';
import type { Repositories } from '../db/repositories.js';
import type { ServerEvent } from '../conversation/events.js';

export interface ProjectHubDeps {
  repos: Repositories;
  config: ServerConfig;
}

/**
 * In-memory per-project hub. Owns everything scene-scoped: the preview client
 * set, the scene event stream and operation/artifact persistence. All
 * conversations of a project share one hub.
 */
export class ProjectHub {
  private readonly listeners = new Set<(event: ServerEvent) => void>();
  private readonly previewClients = new Set<string>();

  constructor(
    readonly projectId: string,
    private readonly deps: ProjectHubDeps,
  ) {}

  subscribe(listener: (event: ServerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getPreviewClientIds(): string[] {
    return [...this.previewClients];
  }

  setPreviewClient(clientId: string, attached: boolean): void {
    if (attached) this.previewClients.add(clientId);
    else this.previewClients.delete(clientId);
  }

  isPreviewAttached(): boolean {
    return this.previewClients.size > 0;
  }

  requirePreview(): void {
    if (!this.isPreviewAttached()) {
      throw new Error(
        'No preview renderer is connected. Scene tools are unavailable. ' +
          'Tell the user to open the preview panel, or continue planning and retry.',
      );
    }
  }

  getSnapshot(): ProjectSnapshot {
    const project = this.deps.repos.projects.get(this.projectId);
    if (!project) throw new Error(`Project ${this.projectId} not found.`);
    return {
      project,
      conversations: this.deps.repos.conversations.list(this.projectId),
      operations: this.deps.repos.sceneOperations.list(this.projectId),
      artifacts: this.deps.repos.artifacts.list(this.projectId),
      scene: this.deps.repos.sceneState.getMeta(this.projectId) ?? null,
    };
  }

  saveScene(input: { glb: Buffer; lighting: SetupLightingInput | null }): ProjectSceneMeta {
    if (input.glb.byteLength > this.deps.config.maxArtifactBytes) {
      throw new Error(`Scene snapshot exceeds the ${this.deps.config.maxArtifactBytes} byte limit.`);
    }
    const scene = this.deps.repos.sceneState.save(this.projectId, input);
    this.emit({ type: 'scene.updated', projectId: this.projectId, scene });
    return scene;
  }

  recordOperation(
    conversationId: string,
    tool: string,
    input: unknown,
    result: ToolExecutionResult,
  ): SceneOperation {
    const operation = this.deps.repos.sceneOperations.create({
      projectId: this.projectId,
      conversationId,
      tool,
      input,
      result,
    });
    this.emit({ type: 'scene.operation', projectId: this.projectId, operation });
    return operation;
  }

  /**
   * Removes audit records from the operation log. The log is otherwise
   * append-only; this is the only sanctioned deletion path.
   */
  removeOperations(ids: string[]): number {
    const removed = this.deps.repos.sceneOperations.removeMany(this.projectId, ids);
    if (removed > 0) {
      this.emit({ type: 'scene.operations_pruned', projectId: this.projectId, ids });
    }
    return removed;
  }

  saveArtifact(
    conversationId: string,
    input: {
      kind: ArtifactRecord['kind'];
      filename: string;
      mime: string;
      data: Buffer;
      meta?: Record<string, unknown>;
    },
  ): ArtifactRecord {
    if (input.data.byteLength > this.deps.config.maxArtifactBytes) {
      throw new Error(`Artifact exceeds the ${this.deps.config.maxArtifactBytes} byte limit.`);
    }
    const artifact = this.deps.repos.artifacts.create({
      projectId: this.projectId,
      conversationId,
      kind: input.kind,
      filename: input.filename,
      mime: input.mime,
      data: input.data,
      meta: input.meta,
    });
    this.emit({ type: 'artifact.created', projectId: this.projectId, artifact });
    return artifact;
  }

  private emit(event: ServerEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // listeners must never break a run
      }
    }
  }
}
