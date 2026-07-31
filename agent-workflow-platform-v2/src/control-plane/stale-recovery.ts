import { withTransaction } from '../db/pool.js';

export async function recoverStaleRunningTask(
  taskId: string,
  staleBefore: Date,
): Promise<{ recovered: boolean; attempt: number }> {
  return withTransaction(async (client) => {
    const selected = await client.query<{
      status: string;
      attempt: number;
      updated_at: Date;
    }>(
      'SELECT status, attempt, updated_at FROM tasks WHERE task_id = $1 FOR UPDATE',
      [taskId],
    );
    const task = selected.rows[0];
    if (!task) throw new Error(`Task not found during stale recovery: ${taskId}`);
    if (task.status !== 'RUNNING' || task.updated_at.getTime() >= staleBefore.getTime()) {
      return { recovered: false, attempt: task.attempt };
    }
    await client.query(
      `UPDATE executions
       SET status = 'INTERRUPTED',
           error = COALESCE(error, 'STALE_LOCK_RECOVERED'),
           finished_at = COALESCE(finished_at, now())
       WHERE task_id = $1 AND attempt = $2 AND status = 'STARTED'`,
      [taskId, task.attempt],
    );
    await client.query(
      `UPDATE tasks
       SET status = 'RETRY_WAIT',
           next_run_at = now(),
           last_error = 'STALE_LOCK_RECOVERED',
           updated_at = now()
       WHERE task_id = $1`,
      [taskId],
    );
    return { recovered: true, attempt: task.attempt };
  });
}
