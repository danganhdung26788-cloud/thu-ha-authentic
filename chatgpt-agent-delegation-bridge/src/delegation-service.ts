import type { BridgeConfig } from './config.js';
import {
  CodexDelegationInputSchema,
  DelegationResultSchema,
  ExecuteApprovedLocalOperationsInputSchema,
  LocalInspectInputSchema,
  LocalOperationPlanSchema,
  PrepareLocalOperationsInputSchema,
  SpecialistDelegationInputSchema,
  type CodexDelegationInput,
  type DelegationResult,
  type ExecuteApprovedLocalOperationsInput,
  type LocalInspectInput,
  type PrepareLocalOperationsInput,
  type SpecialistDelegationInput,
} from './contracts.js';
import { LocalApprovalError, LocalApprovalStore } from './local-approval-store.js';
import { redactSecrets } from './redaction.js';
import { AgentsSdkSpecialist } from './specialists/agents-sdk.js';
import { CodexSpecialist } from './specialists/codex.js';
import { LocalExecutor } from './specialists/local-executor.js';
import { WorkspaceRegistry } from './workspace-registry.js';

type CacheEntry = Readonly<{
  promise: Promise<DelegationResult>;
  expiresAt: number;
}>;

function evidence(name: string, payload: unknown) {
  return {
    name,
    mediaType: 'application/json',
    contentBase64: Buffer.from(JSON.stringify(payload, null, 2), 'utf8').toString('base64'),
  };
}

export class DelegationService {
  readonly #codex: CodexSpecialist;
  readonly #localExecutor: LocalExecutor;
  readonly #specialist: AgentsSdkSpecialist;
  readonly #approvals: LocalApprovalStore;
  readonly #cache = new Map<string, CacheEntry>();

  constructor(
    readonly config: BridgeConfig,
    readonly workspaces: WorkspaceRegistry,
  ) {
    this.#codex = new CodexSpecialist(config, workspaces);
    this.#localExecutor = new LocalExecutor(config, workspaces);
    this.#specialist = new AgentsSdkSpecialist(config);
    this.#approvals = new LocalApprovalStore(config.localExecutor.approvalTtlSeconds);
  }

  async askCodex(raw: unknown): Promise<DelegationResult> {
    const input = CodexDelegationInputSchema.parse(raw);
    const workspace = this.workspaces.get(input.workspaceId);
    for (const path of input.paths) this.workspaces.resolvePath(workspace, path);
    return this.deduplicate('ask_codex', input.idempotencyKey, () => this.#codex.run(workspace, input));
  }

  async inspectLocalRuntime(raw: unknown): Promise<DelegationResult> {
    const input = LocalInspectInputSchema.parse(raw);
    const workspace = this.workspaces.get(input.workspaceId);
    return this.deduplicate('inspect_local_runtime', input.idempotencyKey, () => this.#localExecutor.inspect(workspace, input));
  }

  async prepareLocalOperations(raw: unknown): Promise<DelegationResult> {
    const input = PrepareLocalOperationsInputSchema.parse(raw);
    const workspace = this.workspaces.get(input.workspaceId);
    const plan = LocalOperationPlanSchema.parse(input);
    const planSummary = await this.#localExecutor.validatePlan(workspace, plan);
    const grant = this.#approvals.prepare(
      workspace.workspaceId,
      plan,
      input.approvalTtlSeconds,
      input.idempotencyKey,
    );
    const result = {
      approvalId: grant.approvalId,
      planHash: grant.planHash,
      createdAt: grant.createdAt,
      expiresAt: grant.expiresAt,
      workspaceId: grant.workspaceId,
      singleUse: true,
      persisted: false,
      planSummary,
    };
    return this.validateAndBound({
      requestId: `PREPARE-${grant.approvalId}`,
      target: 'LOCAL_EXECUTOR',
      status: 'SUCCEEDED',
      summary: 'The exact bounded local-operation plan was validated. Show this plan to the user and obtain explicit approval before calling execute_local_operations.',
      result,
      warnings: ['The approval grant is ephemeral, single-use, hash-bound, and expires automatically.'],
      evidence: [evidence('local-operation-approval-plan.json', result)],
      retryable: false,
    });
  }

  async executeApprovedLocalOperations(raw: unknown): Promise<DelegationResult> {
    const input = ExecuteApprovedLocalOperationsInputSchema.parse(raw);
    return this.deduplicate('execute_local_operations', input.idempotencyKey, async () => {
      try {
        const grant = this.#approvals.claim(input.approvalId, input.planHash);
        const workspace = this.workspaces.get(grant.workspaceId);
        return this.#localExecutor.execute(workspace, {
          ...grant.plan,
          idempotencyKey: input.idempotencyKey,
        });
      } catch (error) {
        if (error instanceof LocalApprovalError) {
          return {
            requestId: input.idempotencyKey,
            target: 'LOCAL_EXECUTOR',
            status: 'BLOCKED',
            summary: error.message,
            result: {},
            warnings: [],
            evidence: [],
            retryable: false,
            errorCode: error.code,
          };
        }
        throw error;
      }
    });
  }

  async askSpecialist(raw: unknown): Promise<DelegationResult> {
    const input = SpecialistDelegationInputSchema.parse(raw);
    return this.deduplicate('ask_specialist_agent', input.idempotencyKey, () => this.#specialist.run(input));
  }

  revokeLocalApprovals(): number {
    return this.#approvals.revokeAll();
  }

  async health(): Promise<Record<string, unknown>> {
    const workspaces = this.workspaces.list();
    const localReadAvailable = this.config.localExecutor.enabled
      && workspaces.some((workspace) => workspace.localRead);
    const localWriteAvailable = this.config.localExecutor.enabled
      && workspaces.some((workspace) => workspace.localWrite);
    return {
      ok: this.config.codex.enabled || localReadAvailable || localWriteAvailable || this.config.specialist.enabled,
      architecture: {
        chatgptPrimaryBrain: true,
        backendManagerAgent: false,
        automaticBackendRouting: false,
        separateChatUi: false,
        persistentBusinessState: false,
        v2RuntimeDependency: false,
        specialistAiMayMutateUserWorkspace: false,
      },
      targets: {
        codex: {
          enabled: this.config.codex.enabled,
          mode: 'READ_ONLY_PROPOSAL',
          readBoundary: 'REGISTERED_WORKSPACE_ROOT',
        },
        localExecutor: {
          ...this.#localExecutor.health(),
          readAvailable: localReadAvailable,
          writeAvailable: localWriteAvailable,
          publishedMode: localWriteAvailable ? 'TWO_STEP_CONTROLLED_WRITE' : 'READ_ONLY',
          approvalTtlSeconds: this.config.localExecutor.approvalTtlSeconds,
          approvals: this.#approvals.stats(),
        },
        specialistAgent: {
          enabled: this.config.specialist.enabled,
          modelConfigured: Boolean(this.config.specialist.model),
          mode: 'ANSWER_ONLY',
        },
      },
      workspaces,
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
    this.#cache.set(cacheKey, { promise, expiresAt: Date.now() + 10 * 60 * 1_000 });
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
  ExecuteApprovedLocalOperationsInput,
  LocalInspectInput,
  PrepareLocalOperationsInput,
  SpecialistDelegationInput,
};
