import { TaskRecordSchema, type TaskRecord } from '../domain/task.js';
import { withTransaction } from '../db/pool.js';
import type { TaskJobData } from '../queue/task-queue.js';

type TaskRow = Readonly<{
  task_id: string;
  correlation_id: string;
  idempotency_key: string;
  owner_id: string;
  workspace_id: string;
  objective: string;
  read_scope: unknown;
  write_scope: unknown;
  autonomy_mode: string;
  risk_level: string;
  payload: unknown;
  status: string;
  attempt: number;
  max_attempts: number;
  next_run_at: Date | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}>;

function mapTask(row: TaskRow): TaskRecord {
  return TaskRecordSchema.parse({
    taskId: row.task_id,
    correlationId: row.correlation_id,
    idempotencyKey: row.idempotency_key,
    ownerId: row.owner_id,
    workspaceId: row.workspace_id,
    objective: row.objective,
    readScope: row.read_scope,
    writeScope: row.write_scope,
    autonomyMode: row.autonomy_mode,
    riskLevel: row.risk_level,
    payload: row.payload,
    status: row.status,
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    nextRunAt: row.next_run_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export type TaskClaimResult = Readonly<{
  claimed: boolean;
  previousStatus: TaskRecord['status'];
  task: TaskRecord;
  reason: string;
}>;

export async function claimTaskForExecution(envelope: TaskJobData): Promise<TaskClaimResult> {
  return withTransaction(async (client) => {
    const selected = await client.query<TaskRow>(
      'SELECT * FROM tasks WHERE task_id = $1 FOR UPDATE',
      [envelope.taskId],
    );
    const row = selected.rows[0];
    if (!row) throw new Error(`Task not found: ${envelope.taskId}`);
    const task = mapTask(row);
    if (
      task.ownerId !== envelope.ownerId
      || task.workspaceId !== envelope.workspaceId
      || task.correlationId !== envelope.correlationId
    ) {
      throw new Error('Queue envelope does not match persisted owner/workspace/correlation contract.');
    }
    if (!['QUEUED', 'RETRY_WAIT'].includes(task.status)) {
      return {
        claimed: false,
        previousStatus: task.status,
        task,
        reason: `Task status is not claimable: ${task.status}`,
      };
    }
    if (task.status === 'RETRY_WAIT' && task.nextRunAt && task.nextRunAt.getTime() > Date.now()) {
      return {
        claimed: false,
        previousStatus: task.status,
        task,
        reason: `Retry is not due until ${task.nextRunAt.toISOString()}`,
      };
    }
    if (task.attempt >= task.maxAttempts) {
      const failed = await client.query<TaskRow>(
        `UPDATE tasks SET status = 'FAILED', last_error = 'MAX_ATTEMPTS_EXHAUSTED',
          updated_at = now() WHERE task_id = $1 RETURNING *`,
        [task.taskId],
      );
      const failedRow = failed.rows[0];
      if (!failedRow) throw new Error(`Task attempt exhaustion update failed: ${task.taskId}`);
      return {
        claimed: false,
        previousStatus: task.status,
        task: mapTask(failedRow),
        reason: 'Maximum attempts exhausted.',
      };
    }
    const claimed = await client.query<TaskRow>(
      `UPDATE tasks SET status = 'RUNNING', attempt = attempt + 1,
        next_run_at = NULL, last_error = NULL, updated_at = now()
       WHERE task_id = $1 RETURNING *`,
      [task.taskId],
    );
    const claimedRow = claimed.rows[0];
    if (!claimedRow) throw new Error(`Task claim update failed: ${task.taskId}`);
    return {
      claimed: true,
      previousStatus: task.status,
      task: mapTask(claimedRow),
      reason: 'Task claimed under PostgreSQL row lock.',
    };
  });
}
