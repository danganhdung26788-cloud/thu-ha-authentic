import type { Executor } from '../contracts/execution-context.js';
import { getEnv } from '../config/env.js';
import type { ExecutorAdapter } from './contracts.js';
import { HttpExecutorAdapter } from './http-adapter.js';

export class ExecutorRegistry {
  readonly #adapters = new Map<string, ExecutorAdapter>();

  register(executor: Executor, adapter: ExecutorAdapter): void {
    if (this.#adapters.has(executor)) {
      throw new Error(`Executor already registered: ${executor}`);
    }
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
  const token = process.env.ADAPTER_AUTH_TOKEN;
  if (env.HERMES_ADAPTER_URL) {
    registry.register('HERMES', new HttpExecutorAdapter('hermes', env.HERMES_ADAPTER_URL, token));
  }
  if (env.CODEX_ADAPTER_URL) {
    registry.register('CODEX', new HttpExecutorAdapter('codex', env.CODEX_ADAPTER_URL, token));
  }
  if (env.CLAUDE_ADAPTER_URL) {
    registry.register('CLAUDE_REVIEW', new HttpExecutorAdapter('claude-review', env.CLAUDE_ADAPTER_URL, token));
  }
  return registry;
}
