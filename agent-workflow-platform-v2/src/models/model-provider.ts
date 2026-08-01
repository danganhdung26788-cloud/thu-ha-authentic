import { OpenAIProvider, type ModelProvider } from '@openai/agents';
import { getEnv } from '../config/env.js';

export type ModelProviderHealth = Readonly<{
  ok: boolean;
  provider: 'ollama' | 'openai';
  baseUrl: string;
  managerModel: string;
  specialistModel: string;
  modelAvailable: boolean;
  latencyMs: number;
  error?: string;
}>;

export type ResolvedModelConfiguration = Readonly<{
  provider: 'ollama' | 'openai';
  baseUrl: string;
  apiKey: string;
  managerModel: string;
  specialistModel: string;
  useResponses: boolean;
  requestTimeoutMs: number;
}>;

let cachedProvider: ModelProvider | undefined;

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

export function resolveModelConfiguration(): ResolvedModelConfiguration {
  const env = getEnv();
  const provider = env.MODEL_PROVIDER;
  const managerModel = env.MANAGER_MODEL.trim();
  const specialistModel = env.SPECIALIST_MODEL.trim();
  if (!managerModel) throw new Error('MANAGER_MODEL is required.');
  if (!specialistModel) throw new Error('SPECIALIST_MODEL is required.');

  if (provider === 'ollama') {
    return {
      provider,
      baseUrl: trimTrailingSlash(env.MODEL_BASE_URL),
      apiKey: env.MODEL_API_KEY,
      managerModel,
      specialistModel,
      useResponses: false,
      requestTimeoutMs: env.MODEL_REQUEST_TIMEOUT_MS,
    };
  }

  const apiKey = env.OPENAI_API_KEY?.trim() || env.MODEL_API_KEY.trim();
  if (!apiKey || apiKey === 'ollama-local') {
    throw new Error('OPENAI_API_KEY or a non-placeholder MODEL_API_KEY is required when MODEL_PROVIDER=openai.');
  }
  return {
    provider,
    baseUrl: trimTrailingSlash(env.MODEL_BASE_URL),
    apiKey,
    managerModel,
    specialistModel,
    useResponses: env.MODEL_USE_RESPONSES,
    requestTimeoutMs: env.MODEL_REQUEST_TIMEOUT_MS,
  };
}

export function getConfiguredModelProvider(): ModelProvider {
  if (cachedProvider) return cachedProvider;
  const config = resolveModelConfiguration();
  cachedProvider = new OpenAIProvider({
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
    useResponses: config.useResponses,
    strictFeatureValidation: config.provider === 'openai',
  });
  return cachedProvider;
}

export function resetModelProviderForTests(): void {
  cachedProvider = undefined;
}

export async function modelProviderHealthCheck(): Promise<ModelProviderHealth> {
  const started = performance.now();
  let config: ResolvedModelConfiguration;
  try {
    config = resolveModelConfiguration();
  } catch (error) {
    return {
      ok: false,
      provider: getEnv().MODEL_PROVIDER,
      baseUrl: getEnv().MODEL_BASE_URL,
      managerModel: getEnv().MANAGER_MODEL,
      specialistModel: getEnv().SPECIALIST_MODEL,
      modelAvailable: false,
      latencyMs: Math.round(performance.now() - started),
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  try {
    const response = await fetch(`${config.baseUrl}/models`, {
      method: 'GET',
      headers: { authorization: `Bearer ${config.apiKey}` },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Model provider returned HTTP ${response.status}.`);
    }
    const payload = await response.json() as {
      data?: Array<{ id?: unknown }>;
      models?: Array<{ name?: unknown; model?: unknown }>;
    };
    const modelIds = new Set<string>();
    for (const item of payload.data ?? []) {
      if (typeof item.id === 'string') modelIds.add(item.id);
    }
    for (const item of payload.models ?? []) {
      if (typeof item.name === 'string') modelIds.add(item.name);
      if (typeof item.model === 'string') modelIds.add(item.model);
    }
    const modelAvailable = modelIds.has(config.managerModel)
      || [...modelIds].some((value) => value.startsWith(`${config.managerModel}:`));
    return {
      ok: modelAvailable,
      provider: config.provider,
      baseUrl: config.baseUrl,
      managerModel: config.managerModel,
      specialistModel: config.specialistModel,
      modelAvailable,
      latencyMs: Math.round(performance.now() - started),
      ...(modelAvailable ? {} : { error: `Manager model is not available: ${config.managerModel}` }),
    };
  } catch (error) {
    return {
      ok: false,
      provider: config.provider,
      baseUrl: config.baseUrl,
      managerModel: config.managerModel,
      specialistModel: config.specialistModel,
      modelAvailable: false,
      latencyMs: Math.round(performance.now() - started),
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}
