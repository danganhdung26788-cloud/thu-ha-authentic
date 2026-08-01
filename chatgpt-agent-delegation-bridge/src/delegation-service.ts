import type { BridgeConfig } from './config.js';
import {
  CodexDelegationInputSchema,
  DelegationResultSchema,
  LocalExecuteInputSchema,
  LocalInspectInputSchema,
  SpecialistDelegationInputSchema,
  type CodexDelegationInput,
  type DelegationResult,
  type LocalExecuteInput,
  type LocalInspectInput,
  type SpecialistDelegationInput,
} from './contracts.js';
import { redactSecrets } from './redaction.js';
import { AgentsSdkSpecialist } from './specialists/agents-sdk.js';
import { CodexSpecialist } from './specialists/codex.js';
import { LocalExecutor } from './specialists/local-executor.js';
import { WorkspaceRegistry } from './workspace-registry.js';

type CacheEntry = Readonly<{
  promise: Promise<DelegationResult>;
  expiresAt: number;
}>;

export class DelegationService {
  readonly #codex: CodexSpecialist;
  readonly #localExecutor: LocalExecutor;
  readonly #specialist: AgentsSdkSpecialist;
  readonly #cache = new Map<string, CacheEntry>();

  constructor(
    readonly config: BridgeConfig,
    readonly workspaces: WorkspaceRegistry,
  ) {
    this.#codex = new CodexSpecialist(config);
    this.#localExecutor = new LocalExecutor(config, workspaces);
    this.#specialist = new AgentsSdkSpecialist(config);
  }

  async askCodex(raw: unknown): Promise<DelegationResult> {
    const input = CodexDelegationInputSchema.parse(raw);
    const workspace = this.workspaces.get(input.workspaceId);
    for (const path of input.paths) this.workspaces.resolvePath(workspace, path);
    return this.deduplicate(
      'ask_codex',
      input.idempotencyKey,
      () => this.#codex.run('read', workspace, input),
    );
  }

  async executeCodex(raw: unknown): Promise<DelegationResult> {
    const input = CodexDelegationInputSchema.parse(raw);
    const workspace = this.workspaces.get(input.workspaceId);
    for (const path of input.paths) this.workspaces.resolvePath(workspace, path);
    return this.deduplicate(
      'execute_codex',
      input.idempotencyKey,
      () => this.#codex.run('write', workspace, input),
    );
  }

  async inspectLocalRuntime(raw: unknown): Promise<DelegationResult> {
    const input = LocalInspectInputSchema.parse(raw);
    const workspace = this.workspaces.get(input.workspaceId);
    return this.deduplicate(
      'inspect_local_runtime',
      input.idempotencyKey,
      () => this.#localExecutor.inspect(workspace, input),
    );
  }

  async executeLocalOperations(raw: unknown): Promise<DelegationResult> {
    const input = LocalExecuteInputSchema.parse(raw);
    const workspace = this.workspaces.get(input.workspaceId);
    return this.deduplicate(
      'execute_local_operations',
      input.idempotencyKey,
      () => this.#localExecutor.execute(workspace, input),
    );
  }

  async askSpecialist(raw: unknown): Promise<DelegationResult> {
    const input = SpecialistDelegationInputSchema.parse(raw);
    return this.deduplicate(
      'ask_specialist_agent',
      input.idempotencyKey,
      () => this.#specialist.run(input),
    );
  }

  async health(): Promise<Record<string, unknown>> {
    return {
      ok: this.config.codex.enabled
        || this.config.localExecutor.enabled
        || this.config.specialist.enabled,
      architecture: {
        chatgptPrimaryBrain: true,
        backendManagerAgent: false,
        automaticBackendRouting: false,
        separateChatUi: false,
        persistentBusinessState: false,
        v2RuntimeDependency: false,
      },
      targets: {
        codex: { enabled: this.config.codex.enabled },
        localExecutor: this.#localExecutor.health(),
        specialistAgent: {
          enabled: this.config.specialist.enabled,
          modelConfigured: Boolean(this.config.specialist.model),
        },
      },
      workspaces: this.workspaces.list(),
    };
  }

  private async deduplicate(
    namespace: string,
    idempotencyKey: string | undefined,
    operation: () => Promise<DelegationResult>,
  ): Promise<DelegationResult> {
    this.pruneCache();
    if (!idempotencyKey) return this.validateAndBound(await operation());
    const cacheKey = `${namespace}\u0000${idempotencyKey}`;
    const existing = this.#cache.get(cacheKey);
    if (existing && existing.expiresAt > Date.now()) return existing.promise;
    const promise = operation()
      .then((result) => this.validateAndBound(result))
      .catch((error) => {
        this.#cache.delete(cacheKey);
        throw error;
      });
    this.#cache.set(cacheKey, {
      promise,
      expiresAt: Date.now() + 10 * 60 * 1_000,
    });
    return promise;
  }

  private validateAndBound(raw: DelegationResult): DelegationResult {
    const parsed = DelegationResultSchema.parse(raw);
    const serialized = JSON.stringify(parsed);
    if (Buffer.byteLength(serialized, 'utf8') <= this.config.maxOutputBytes) return parsed;
    return {
      ...parsed,
      summary: redactSecrets(
        parsed.summary,
        Math.min(64_000, this.config.maxOutputBytes / 2),
      ),
      result: { truncated: true, reason: 'Delegation result exceeded bridge output limit.' },
      evidence: [],
      warnings: [...parsed.warnings, 'Large result was truncated by the delegation bridge.'],
    };
  }

  private pruneCache(): void {
    const now = Date.now();
    for (const [key, entry] of this.#cache) {
      if (entry.expiresAt <= now) this.#cache.delete(key);
    }
  }
}

export type {
  CodexDelegationInput,
  LocalExecuteInput,
  LocalInspectInput,
  SpecialistDelegationInput,
};
