import type { Executor } from '../contracts/execution-context.js';
import { getEnv } from '../config/env.js';
import type { ExecutorAdapter } from './contracts.js';
import { GeminiExecutorAdapter } from './gemini-adapter.js';
import { HttpExecutorAdapter } from './http-adapter.js';
import { NotebookLmSourcePackageAdapter } from './notebooklm-adapter.js';

export class ExecutorRegistry {
  readonly #adapters = new Map<string, ExecutorAdapter>();

  register(executor: Executor, adapter: ExecutorAdapter): void {
    if (this.#adapters.has(executor)) throw new Error(`Executor already registered: ${executor}`);
    this.#adapters.set(executor, adapter);
  }

  get(executor: Executor): ExecutorAdapter {
    const adapter = this.#adapters.get(executor);
    if (!adapter) throw new Error(`Executor adapter unavailable: ${executor}`);
    return adapter;
  }

  entries(): ReadonlyArray<readonly [string, ExecutorAdapter]> {
    return [...this.#adapters.entries()];
  }
}

export function createExecutorRegistry(): ExecutorRegistry {
  const env = getEnv();
  const registry = new ExecutorRegistry();
  if (env.HERMES_ADAPTER_URL) {
    registry.register('HERMES', new HttpExecutorAdapter('hermes', env.HERMES_ADAPTER_URL, env.ADAPTER_AUTH_TOKEN));
  }
  if (env.CODEX_ADAPTER_URL) {
    registry.register('CODEX', new HttpExecutorAdapter('codex', env.CODEX_ADAPTER_URL, env.ADAPTER_AUTH_TOKEN));
  }
  if (env.CLAUDE_ADAPTER_URL) {
    registry.register('CLAUDE_REVIEW', new HttpExecutorAdapter('claude-review', env.CLAUDE_ADAPTER_URL, env.ADAPTER_AUTH_TOKEN));
  }
  if (env.GOOGLE_API_KEY && env.GEMINI_MODEL) {
    registry.register('GEMINI', new GeminiExecutorAdapter({
      apiKey: env.GOOGLE_API_KEY,
      model: env.GEMINI_MODEL,
      apiVersion: env.GEMINI_API_VERSION,
    }));
  }
  if (env.NOTEBOOKLM_SOURCE_PACKAGE_ONLY) {
    registry.register('NOTEBOOKLM', new NotebookLmSourcePackageAdapter());
  }
  if (env.CANVA_ADAPTER_URL) {
    registry.register('CANVA', new HttpExecutorAdapter('canva', env.CANVA_ADAPTER_URL, env.CANVA_ACCESS_TOKEN ?? env.ADAPTER_AUTH_TOKEN));
  }
  return registry;
}
