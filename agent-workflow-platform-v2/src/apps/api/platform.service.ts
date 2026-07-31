import { randomUUID } from 'node:crypto';
import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { z } from 'zod';
import { PostgresControlPlaneStore } from '../../control-plane/postgres-store.js';
import { MinioEvidenceStore } from '../../evidence/minio-evidence-store.js';
import { createTaskQueue, enqueueTask } from '../../queue/task-queue.js';

const SubmitTaskSchema = z.object({
  taskId: z.string().min(1).optional(),
  correlationId: z.string().min(1).optional(),
  idempotencyKey: z.string().min(1),
  ownerId: z.string().min(1),
  workspaceId: z.string().min(1),
  objective: z.string().min(1),
  readScope: z.array(z.string().min(1)).min(1),
  writeScope: z.array(z.string().min(1)).default([]),
  autonomyMode: z.enum(['READ_ONLY', 'SANDBOX_HIGH', 'UAT_HIGH', 'PRODUCTION_GUARDED']),
  riskLevel: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
  payload: z.record(z.string(), z.unknown()).default({}),
  maxAttempts: z.number().int().min(1).max(10).default(3),
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
    const { task, created } = await this.#store.createTask({
      ...parsed,
      taskId,
      correlationId,
    });
    if (created) {
      await this.#store.appendAudit({
        eventId: `AUD-${randomUUID()}`,
        taskId,
        correlationId,
        ownerId: parsed.ownerId,
        workspaceId: parsed.workspaceId,
        eventType: 'TASK_CREATED',
        actor: 'API',
        details: { autonomyMode: parsed.autonomyMode, riskLevel: parsed.riskLevel },
      });
      await enqueueTask(this.#queue, {
        taskId,
        correlationId,
        ownerId: parsed.ownerId,
        workspaceId: parsed.workspaceId,
      });
    }
    return { created, task };
  }

  async getTask(taskId: string): Promise<Record<string, unknown> | null> {
    return this.#store.getTask(taskId);
  }

  async readiness(): Promise<Record<string, boolean>> {
    const db = await this.#store.healthCheck().catch(() => false);
    const redis = await this.#queue.client.then((client) => client.ping().then(() => true)).catch(() => false);
    const evidence = await this.#evidence.healthCheck().catch(() => false);
    return { db, redis, evidence, ready: db && redis && evidence };
  }

  async onApplicationShutdown(): Promise<void> {
    await this.#queue.close();
  }
}
