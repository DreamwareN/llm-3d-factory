import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';

export interface ProviderCredentials {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  headers: Record<string, string>;
  defaultModel: string;
}

type CompatibleProvider = ReturnType<typeof createOpenAICompatible>;

export class ProviderRegistry {
  private cache = new Map<string, { signature: string; provider: CompatibleProvider }>();

  private getProvider(credentials: ProviderCredentials): CompatibleProvider {
    const signature = JSON.stringify({
      baseUrl: credentials.baseUrl,
      apiKey: credentials.apiKey,
      headers: credentials.headers,
    });
    const cached = this.cache.get(credentials.id);
    if (cached && cached.signature === signature) return cached.provider;

    const provider = createOpenAICompatible({
      name: 'llm3d',
      baseURL: credentials.baseUrl,
      apiKey: credentials.apiKey || undefined,
      headers: credentials.headers,
      includeUsage: true,
    });
    this.cache.set(credentials.id, { signature, provider });
    return provider;
  }

  getModel(credentials: ProviderCredentials, modelId?: string): LanguageModel {
    const provider = this.getProvider(credentials);
    return provider.chatModel(modelId || credentials.defaultModel);
  }

  async listModels(
    credentials: Pick<ProviderCredentials, 'baseUrl' | 'apiKey' | 'headers'>,
  ): Promise<string[]> {
    const base = credentials.baseUrl.replace(/\/+$/, '');
    const response = await fetch(`${base}/models`, {
      headers: {
        ...credentials.headers,
        ...(credentials.apiKey ? { Authorization: `Bearer ${credentials.apiKey}` } : {}),
      },
    });
    if (!response.ok) {
      throw new Error(`Model list request failed with status ${response.status}`);
    }
    const payload = (await response.json()) as { data?: Array<{ id?: unknown }> };
    return (payload.data ?? [])
      .map((entry) => entry.id)
      .filter((id): id is string => typeof id === 'string')
      .sort((a, b) => a.localeCompare(b));
  }
}

export const providerRegistry = new ProviderRegistry();
