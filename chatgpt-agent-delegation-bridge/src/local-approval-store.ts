import { createHash, randomUUID } from 'node:crypto';
import type { LocalOperationPlan } from './contracts.js';

export type LocalApprovalGrant = Readonly<{
  approvalId: string;
  planHash: string;
  workspaceId: string;
  plan: LocalOperationPlan;
  createdAt: string;
  expiresAt: string;
}>;

type StoredGrant = LocalApprovalGrant & {
  consumedAt?: string;
};

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalize(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function localPlanHash(workspaceId: string, plan: LocalOperationPlan): string {
  return createHash('sha256')
    .update(canonicalize({ workspaceId, plan }), 'utf8')
    .digest('hex');
}

export class LocalApprovalError extends Error {
  constructor(
    readonly code: 'LOCAL_APPROVAL_NOT_FOUND' | 'LOCAL_APPROVAL_EXPIRED' | 'LOCAL_APPROVAL_CONSUMED' | 'LOCAL_APPROVAL_HASH_MISMATCH',
    message: string,
  ) {
    super(message);
    this.name = 'LocalApprovalError';
  }
}

export class LocalApprovalStore {
  readonly #grants = new Map<string, StoredGrant>();
  readonly #prepareKeys = new Map<string, string>();

  constructor(
    readonly defaultTtlSeconds: number,
    readonly now: () => number = Date.now,
  ) {}

  prepare(
    workspaceId: string,
    plan: LocalOperationPlan,
    requestedTtlSeconds: number | undefined,
    idempotencyKey: string | undefined,
  ): LocalApprovalGrant {
    this.prune();
    const prepareKey = idempotencyKey ? `${workspaceId}\u0000${idempotencyKey}` : undefined;
    if (prepareKey) {
      const existingId = this.#prepareKeys.get(prepareKey);
      const existing = existingId ? this.#grants.get(existingId) : undefined;
      if (existing && !existing.consumedAt && Date.parse(existing.expiresAt) > this.now()) {
        return this.publicGrant(existing);
      }
      this.#prepareKeys.delete(prepareKey);
    }

    const ttlSeconds = requestedTtlSeconds ?? this.defaultTtlSeconds;
    const createdAtMs = this.now();
    const grant: StoredGrant = {
      approvalId: randomUUID(),
      planHash: localPlanHash(workspaceId, plan),
      workspaceId,
      plan,
      createdAt: new Date(createdAtMs).toISOString(),
      expiresAt: new Date(createdAtMs + ttlSeconds * 1_000).toISOString(),
    };
    this.#grants.set(grant.approvalId, grant);
    if (prepareKey) this.#prepareKeys.set(prepareKey, grant.approvalId);
    return this.publicGrant(grant);
  }

  claim(approvalId: string, planHash: string): LocalApprovalGrant {
    this.prune();
    const grant = this.#grants.get(approvalId);
    if (!grant) {
      throw new LocalApprovalError('LOCAL_APPROVAL_NOT_FOUND', 'The local-operation approval does not exist or is no longer available.');
    }
    if (Date.parse(grant.expiresAt) <= this.now()) {
      this.#grants.delete(approvalId);
      throw new LocalApprovalError('LOCAL_APPROVAL_EXPIRED', 'The local-operation approval has expired. Prepare the exact plan again.');
    }
    if (grant.consumedAt) {
      throw new LocalApprovalError('LOCAL_APPROVAL_CONSUMED', 'The local-operation approval was already consumed.');
    }
    if (grant.planHash !== planHash) {
      throw new LocalApprovalError('LOCAL_APPROVAL_HASH_MISMATCH', 'The approved local-operation plan hash does not match.');
    }
    grant.consumedAt = new Date(this.now()).toISOString();
    return this.publicGrant(grant);
  }

  revokeAll(): number {
    const count = this.#grants.size;
    this.#grants.clear();
    this.#prepareKeys.clear();
    return count;
  }

  stats(): Readonly<{ active: number; consumed: number; ephemeral: true }> {
    this.prune();
    let active = 0;
    let consumed = 0;
    for (const grant of this.#grants.values()) {
      if (grant.consumedAt) consumed += 1;
      else active += 1;
    }
    return { active, consumed, ephemeral: true };
  }

  private publicGrant(grant: StoredGrant): LocalApprovalGrant {
    return {
      approvalId: grant.approvalId,
      planHash: grant.planHash,
      workspaceId: grant.workspaceId,
      plan: grant.plan,
      createdAt: grant.createdAt,
      expiresAt: grant.expiresAt,
    };
  }

  private prune(): void {
    const now = this.now();
    for (const [approvalId, grant] of this.#grants) {
      if (Date.parse(grant.expiresAt) <= now) this.#grants.delete(approvalId);
    }
    for (const [key, approvalId] of this.#prepareKeys) {
      if (!this.#grants.has(approvalId)) this.#prepareKeys.delete(key);
    }
  }
}
