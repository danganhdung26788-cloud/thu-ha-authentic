import type { BridgeConfig } from './config.js';
import {
  CodexDelegationInputSchema,
  DelegationResultSchema,
  HermesExecuteInputSchema,
  HermesInspectInputSchema,
  SpecialistDelegationInputSchema,
  type CodexDelegationInput,
  type DelegationResult,
  type HermesExecuteInput,
  type HermesInspectInput,
  type SpecialistDelegationInput,
} from './contracts.js';
import { redactSecrets } from './redaction.js';
import { AgentsSdkSpecialist } from './specialists/agents-sdk.js';
import { CodexSpecialist } from './specialists/codex.js';
import { HermesSpecialist } from './specialists/hermes.js';
import { WorkspaceRegistry } from './workspace-registry.js';

type CacheEntry = Readonly<{
  promise: Promise<DelegationResult>;
  expiresAt: number;
}>;

export class DelegationService {
  readonly #codex: CodexSpecialist;
  readonly #hermes: HermesSpecialist;
  readonly #specialist: AgentsSdkSpecialist;
  readonly #cache = new Map<string, CacheEntry>();

  constructor(
    readonly config: BridgeConfig,
    readonly workspaces: WorkspaceRegistry,
  ) {
    this.#codex = new CodexSpecialist(config);
    this.#hermes = new HermesSpecialist(config);
    this.#specialist = new AgentsSdkSpecialist(config);
  }

  async askCodex(raw: unknown): Promise<DelegationResult> {
    const input = CodexDelegationInputSchema.parse(raw);
    const workspace = this.workspaces.get(input.workspaceId);
    return this.deduplicate(input.idempotencyKey, () => this.#codex.run('read', workspace, input));
  }

  async executeCodex(raw: unknown): Promise<DelegationResult> {
    const input = CodexDelegationInputSchema.parse(raw);
    const workspace = this.workspaces.get(input.workspaceId);
    return this.deduplicate(input.idempotencyKey, () => this.#codex.run('write', workspace, input));
  }

  async inspectWithHermes(raw: unknown): Promise<DelegationResult> {
    const input = HermesInspectInputSchema.parse(raw);
    const workspace = this.workspaces.get(input.workspaceId);
    return this.deduplicate(input.idempotencyKey, () => this.#hermes.inspect(workspace, input));
  }

  async executeWithHermes(raw: unknown): Promise<DelegationResult> {
    const input = HermesExecuteInputSchema.parse(raw);
    const workspace = this.workspaces.get(input.workspaceId);
    return this.deduplicate(input.idempotencyKey, () => this.#hermes.execute(workspace, input));
  }

  async askSpecialist(raw: unknown): Promise<DelegationResult> {
    const input = SpecialistDelegationInputSchema.parse(raw);
    return this.deduplicate(input.idempotencyKey, () => this.#specialist.run(input));
  }

  async health(): Promise<Record<string, unknown>> {
    const hermes = await this.hermesHealth();
    return {
      ok: this.config.codex.enabled || this.config.hermes.enabled || this.config.specialist.enabled,
      architecture: {
        chatgptPrimaryBrain: true,
        backendManagerAgent: false,
        automaticBackendRouting: false,
        separateChatUi: false,
        persistentBusinessState: false,
      },
      targets: {
        codex: { enabled: this.config.codex.enabled },
        hermes,
        specialistAgent: {
          enabled: this.config.specialist.enabled,
          modelConfigured: Boolean(this.config.specialist.model),
        },
      },
      workspaces: this.workspaces.list(),
    };
  }

  private async hermesHealth(): Promise<Record<string, unknown>> {
    if (!this.config.hermes.enabled) return { enabled: false, ready: false };
    const url = this.config.hermes.adapterUrl;
    const token = this.config.hermes.adapterToken;
    if (!url || !token) return { enabled: true, ready: false, error: 'not configured' };
    try {
      const response = await fetch(new URL('/health', url), {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5_000),
      });
      return { enabled: true, ready: response.ok };
    } catch (error) {
      return { enabled: true, ready: false, error: redactSecrets(error, 2_048) };
    }
  }

  private async deduplicate(
    idempotencyKey: string | undefined,
    operation: () => Promise<DelegationResult>,
  ): Promise<DelegationResult> {
    this.pruneCache();
    if (!idempotencyKey) return this.validateAndBound(await operation());
    const existing = this.#cache.get(idempotencyKey);
    if (existing && existing.expiresAt > Date.now()) return existing.promise;
    const promise = operation()
      .then((result) => this.validateAndBound(result))
      .catch((error) => {
        this.#cache.delete(idempotencyKey);
        throw error;
      });
    this.#cache.set(idempotencyKey, {
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
      summary: redactSecrets(parsed.summary, Math.min(64_000, this.config.maxOutputBytes / 2)),
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
  HermesExecuteInput,
  HermesInspectInput,
  SpecialistDelegationInput,
};
