import type {
  ArtifactRecord,
  ConversationRecord,
  ConversationSnapshot,
  MessageRecord,
  ProjectRecord,
  ProviderProfileRecord,
  SceneOperation,
} from '@llm3d/shared';

const BASE = import.meta.env.VITE_API_BASE ?? '';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers,
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Request failed with status ${response.status}`);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function fetchSceneGlb(
  projectId: string,
): Promise<{ dataBase64: string; size: number } | null> {
  const response = await fetch(`${BASE}/api/projects/${projectId}/scene`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Failed to load scene (status ${response.status})`);
  const buffer = await response.arrayBuffer();
  return { dataBase64: arrayBufferToBase64(buffer), size: buffer.byteLength };
}

export interface ConversationCreateInput {
  title?: string;
  providerProfileId: string;
  model: string;
  config?: Record<string, unknown>;
}

export interface ConversationUpdateInput {
  title?: string;
  providerProfileId?: string;
  model?: string;
  resetContext?: boolean;
}

export const api = {
  projects: {
    list: () => request<ProjectRecord[]>('/api/projects'),
    get: (id: string) =>
      request<{ project: ProjectRecord; conversations: ConversationRecord[] }>(
        `/api/projects/${id}`,
      ),
    create: (input: { name: string; description?: string }) =>
      request<ProjectRecord>('/api/projects', { method: 'POST', body: JSON.stringify(input) }),
    update: (id: string, input: { name?: string; description?: string }) =>
      request<ProjectRecord>(`/api/projects/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    remove: (id: string) => request<void>(`/api/projects/${id}`, { method: 'DELETE' }),
    conversations: (id: string) =>
      request<ConversationRecord[]>(`/api/projects/${id}/conversations`),
    createConversation: (id: string, input: ConversationCreateInput) =>
      request<ConversationRecord>(`/api/projects/${id}/conversations`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    operations: (id: string) => request<SceneOperation[]>(`/api/projects/${id}/operations`),
    pruneOperations: (id: string, ids: string[]) =>
      request<{ removed: number; operations: SceneOperation[] }>(
        `/api/projects/${id}/operations/prune`,
        { method: 'POST', body: JSON.stringify({ ids }) },
      ),
    artifacts: (id: string) => request<ArtifactRecord[]>(`/api/projects/${id}/artifacts`),
    fetchSceneGlb,
  },
  conversations: {
    get: (id: string) => request<ConversationRecord>(`/api/conversations/${id}`),
    snapshot: (id: string) => request<ConversationSnapshot>(`/api/conversations/${id}/snapshot`),
    update: (id: string, input: ConversationUpdateInput) =>
      request<ConversationRecord>(`/api/conversations/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    remove: (id: string) => request<void>(`/api/conversations/${id}`, { method: 'DELETE' }),
    cancel: (id: string) =>
      request<{ ok: boolean }>(`/api/conversations/${id}/cancel`, { method: 'POST' }),
    messages: (id: string) => request<MessageRecord[]>(`/api/conversations/${id}/messages`),
  },
  providers: {
    list: () => request<ProviderProfileRecord[]>('/api/providers'),
    create: (input: {
      name: string;
      baseUrl: string;
      apiKey?: string;
      defaultModel?: string;
      headers?: Record<string, string>;
    }) =>
      request<ProviderProfileRecord>('/api/providers', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    update: (id: string, input: Record<string, unknown>) =>
      request<ProviderProfileRecord>(`/api/providers/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    remove: (id: string) => request<void>(`/api/providers/${id}`, { method: 'DELETE' }),
    test: (id: string) =>
      request<{ ok: boolean; modelCount: number; sample: string[] }>(`/api/providers/${id}/test`, {
        method: 'POST',
      }),
    models: (id: string) => request<{ models: string[] }>(`/api/providers/${id}/models`),
  },
  artifacts: {
    downloadUrl: (id: string) => `${BASE}/api/artifacts/${id}/download`,
  },
};
