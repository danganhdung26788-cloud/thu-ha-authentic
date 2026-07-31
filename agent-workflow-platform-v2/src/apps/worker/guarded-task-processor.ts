import { randomUUID } from 'node:crypto';
import type { Job } from 'bullmq';
import { PostgresControlPlaneStore } from '../../control-plane/postgres-store.js';
import { claimTaskForExecution } from '../../control-plane/task-claim.js';
import type { TaskJobData, TaskJobResult } from '../../queue/task-queue.js';
import { processTaskJob } from './task-processor.js';

export async function processGuardedTaskJob(
  job: Job<TaskJobData, TaskJobResult>,
): Promise<TaskJobResult> {
  const claim = await claimTaskForExecution(job.data);
  const task = claim.task;
  if (!claim.claimed) {
    await new PostgresControlPlaneStore().appendAudit({
      eventId: `AUD-${randomUUID()}`,
      taskId: task.taskId,
      correlationId: task.correlationId,
      ownerId: task.ownerId,
      workspaceId: task.workspaceId,
      eventType: 'TASK_CLAIM_SKIPPED',
      actor: 'ORCHESTRATOR_WORKER',
      details: {
        status: task.status,
        previousStatus: claim.previousStatus,
        reason: claim.reason,
        bullJobId: job.id,
      },
    });
    if (task.status === 'COMPLETED') return { taskId: task.taskId, status: 'COMPLETED' };
    if (task.status === 'WAITING_APPROVAL') {
      return { taskId: task.taskId, status: 'WAITING_APPROVAL' };
    }
    if (task.status === 'FAILED' || task.status === 'CANCELLED') {
      return { taskId: task.taskId, status: 'FAILED' };
    }
    return { taskId: task.taskId, status: 'RETRY_WAIT' };
  }
  return processTaskJob(job);
}
