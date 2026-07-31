import { randomUUID } from 'node:crypto';
import { PostgresControlPlaneStore } from '../../control-plane/postgres-store.js';
import { logger } from '../../observability/logger.js';
import { createTaskQueue, enqueueTask } from '../../queue/task-queue.js';

export class ControlPlanePump {
  readonly #store = new PostgresControlPlaneStore();
  readonly #queue = createTaskQueue();
  #running = false;

  async tick(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      await this.#publishOutbox();
      await this.#recoverTasks();
    } finally {
      this.#running = false;
    }
  }

  async #publishOutbox(): Promise<void> {
    const events = await this.#store.claimOutbox(50);
    for (const event of events) {
      const task = await this.#store.getTask(event.aggregateId);
      if (!task) {
        logger.error({ outboxId: event.outboxId, aggregateId: event.aggregateId }, 'Outbox task missing');
        continue;
      }
      await enqueueTask(
        this.#queue,
        {
          taskId: task.taskId,
          correlationId: task.correlationId,
          ownerId: task.ownerId,
          workspaceId: task.workspaceId,
        },
        { jobId: `outbox-${event.outboxId}-${task.taskId}` },
      );
      await this.#store.markOutboxPublished(event.outboxId);
    }
  }

  async #recoverTasks(): Promise<void> {
    const staleBefore = new Date(Date.now() - 5 * 60_000);
    const tasks = await this.#store.listRecoverableTasks(staleBefore, 100);
    for (const task of tasks) {
      const wasStaleRunning = task.status === 'RUNNING';
      if (wasStaleRunning) {
        await this.#store.updateTaskStatus(task.taskId, 'RETRY_WAIT', {
          attempt: task.attempt,
          nextRunAt: new Date(),
          lastError: 'STALE_LOCK_RECOVERED',
        });
      }
      await enqueueTask(
        this.#queue,
        {
          taskId: task.taskId,
          correlationId: task.correlationId,
          ownerId: task.ownerId,
          workspaceId: task.workspaceId,
        },
        { jobId: `recovery-${task.ownerId}-${task.workspaceId}-${task.taskId}-${task.attempt + 1}` },
      );
      await this.#store.appendAudit({
        eventId: `AUD-${randomUUID()}`,
        taskId: task.taskId,
        correlationId: task.correlationId,
        ownerId: task.ownerId,
        workspaceId: task.workspaceId,
        eventType: wasStaleRunning ? 'STALE_LOCK_RECOVERED' : 'RETRY_REQUEUED',
        actor: 'CONTROL_PLANE_PUMP',
        details: { previousStatus: task.status, attempt: task.attempt },
      });
    }
  }

  async close(): Promise<void> {
    await this.#queue.close();
  }
}
