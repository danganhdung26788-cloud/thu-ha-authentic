import { randomUUID } from 'node:crypto';
import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { z } from 'zod';
import { PostgresControlPlaneStore } from '../../control-plane/postgres-store.js';
import { MinioEvidenceStore } from '../../evidence/minio-evidence-store.js';
import { createExecutorRegistry } from '../../executors/registry.js';
import { modelProviderHealthCheck } from '../../models/model-provider.js';
import { createTaskQueue } from '../../queue/task-queue.js';
import { clamAvHealthCheck } from '../../security/clamav-scanner.js';

const SubmitTaskSchema = z.object({
  taskId: z.string().min(1).optional(),
  correlationId: z.string().min(1).optional(),
  idempotencyKey: z.string().min(1),
  ownerId: z.string().min(1),
  workspaceId: z.string().min(1),
  conversationId: z.string().min(1).nullable().default(null),
  sourceMessageId: z.string().min(1).nullable().default(null),
  objective: z.string().min(1),
  readScope: z.array(z.string().min(1)).min(1),
  writeScope: z.array(z.string().min(1)).default([]),
  autonomyMode: z.enum(['READ_ONLY', 'SANDBOX_HIGH', 'UAT_HIGH', 'PRODUCTION_GUARDED']),
  riskLevel: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
  payload: z.record(z.string(), z.unknown()).default({}),
  maxAttempts: z.number().int().min(1).max(10).default(3),
});

const ApprovalDecisionSchema = z.object({
  decision: z.enum(['APPROVED', 'REJECTED']),
  actor: z.string().min(1),
  reason: z.string().min(1).optional(),
});

@Injectable()
export class PlatformService implements OnApplicationShutdown {
  readonly #store = new PostgresControlPlaneStore();
  readonly #queue = createTaskQueue();
  readonly #evidence = new MinioEvidenceStore();

  async submitTask(input: unknown): Promise<Record<string, unknown>> {
    const parsed = SubmitTaskSchema.parse(input);
    const taskId = parsed.taskId ?? `TASK-${randomUUID()}`;
    const correlationId = parsed.correlationId ?? `CORR-${randomUUID()}`;
    const { task, created } = await this.#store.createTask({ ...parsed, taskId, correlationId });
    if (created) {
      await this.#store.appendAudit({
        eventId: `AUD-${randomUUID()}`,
        taskId,
        correlationId,
        ownerId: parsed.ownerId,
        workspaceId: parsed.workspaceId,
        eventType: 'TASK_CREATED',
        actor: 'API',
        details: {
          autonomyMode: parsed.autonomyMode,
          riskLevel: parsed.riskLevel,
          conversationId: parsed.conversationId,
          sourceMessageId: parsed.sourceMessageId,
          dispatch: 'TRANSACTIONAL_OUTBOX',
        },
      });
    }
    return { created, task };
  }

  async decideApproval(approvalId: string, input: unknown): Promise<Record<string, unknown>> {
    const parsed = ApprovalDecisionSchema.parse(input);
    const decision = await this.#store.decideApproval({
      approvalId,
      decision: parsed.decision,
      actor: parsed.actor,
      ...(parsed.reason ? { reason: parsed.reason } : {}),
    });
    const task = await this.#store.getTask(decision.taskId);
    if (!task) throw new Error(`Task missing after approval decision: ${decision.taskId}`);
    await this.#store.appendAudit({
      eventId: `AUD-${randomUUID()}`,
      taskId: task.taskId,
      correlationId: task.correlationId,
      ownerId: task.ownerId,
      workspaceId: task.workspaceId,
      eventType: parsed.decision === 'APPROVED' ? 'APPROVAL_APPROVED' : 'APPROVAL_REJECTED',
      actor: parsed.actor,
      details: { approvalId, reason: parsed.reason ?? null },
    });
    return { decision, task };
  }

  async getTask(taskId: string): Promise<Record<string, unknown> | null> {
    return this.#store.getTask(taskId);
  }

  async readiness(): Promise<Record<string, boolean>> {
    const db = await this.#store.healthCheck().catch(() => false);
    const redis = await this.#queue.getJobCounts().then(() => true).catch(() => false);
    const evidence = await this.#evidence.healthCheck().catch(() => false);
    const adapterChecks = await Promise.all(
      createExecutorRegistry().entries().map(([, adapter]) => adapter.healthCheck()),
    );
    const adapters = adapterChecks.every(Boolean);
    const model = await modelProviderHealthCheck().then((status) => status.ok).catch(() => false);
    const malwareScanner = await clamAvHealthCheck().catch(() => false);
    return {
      db,
      redis,
      evidence,
      adapters,
      model,
      malwareScanner,
      ready: db && redis && evidence && adapters && model && malwareScanner,
    };
  }

  async onApplicationShutdown(): Promise<void> {
    await this.#queue.close();
  }
}
