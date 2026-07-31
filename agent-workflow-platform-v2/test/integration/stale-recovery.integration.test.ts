import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { resetEnvForTests } from '../../src/config/env.js';
import { PostgresControlPlaneStore } from '../../src/control-plane/postgres-store.js';
import { recoverStaleRunningTask } from '../../src/control-plane/stale-recovery.js';
import { claimTaskForExecution } from '../../src/control-plane/task-claim.js';
import { closePool, getPool } from '../../src/db/pool.js';

const integrationEnabled = process.env.RUN_INTEGRATION === '1';

test('stale recovery interrupts the old execution and schedules a retry', { skip: !integrationEnabled }, async () => {
  resetEnvForTests();
  const store = new PostgresControlPlaneStore();
  const suffix = randomUUID();
  const taskId = `TASK-STALE-${suffix}`;
  const envelope = {
    taskId,
    correlationId: `CORR-${suffix}`,
    ownerId: `owner-${suffix}`,
    workspaceId: `workspace-${suffix}`,
  };
  try {
    await store.createTask({
      ...envelope,
      idempotencyKey: `IDEM-${suffix}`,
      objective: 'Verify stale execution recovery',
      readScope: ['/stale'],
      writeScope: ['/stale'],
      autonomyMode: 'SANDBOX_HIGH',
      riskLevel: 'LOW',
    });
    const claim = await claimTaskForExecution(envelope);
    assert.equal(claim.claimed, true);
    const executionId = `EXE-${taskId}-1`;
    await store.startExecution({
      executionId,
      taskId,
      ownerId: envelope.ownerId,
      workspaceId: envelope.workspaceId,
      executor: 'MANAGER',
      status: 'STARTED',
      attempt: 1,
      startedAt: new Date(Date.now() - 10 * 60_000),
      finishedAt: null,
      result: null,
      error: null,
    });
    await getPool().query(
      "UPDATE tasks SET updated_at = now() - interval '10 minutes' WHERE task_id = $1",
      [taskId],
    );

    const recovery = await recoverStaleRunningTask(
      taskId,
      new Date(Date.now() - 5 * 60_000),
    );
    assert.equal(recovery.recovered, true);
    const task = await store.getTask(taskId);
    assert.equal(task?.status, 'RETRY_WAIT');
    assert.equal(task?.lastError, 'STALE_LOCK_RECOVERED');
    const execution = await getPool().query<{ status: string; error: string }>(
      'SELECT status, error FROM executions WHERE execution_id = $1',
      [executionId],
    );
    assert.equal(execution.rows[0]?.status, 'INTERRUPTED');
    assert.equal(execution.rows[0]?.error, 'STALE_LOCK_RECOVERED');
  } finally {
    const pool = getPool();
    await pool.query('DELETE FROM outbox_events WHERE aggregate_id = $1', [taskId]);
    await pool.query('DELETE FROM audit_events WHERE task_id = $1', [taskId]);
    await pool.query('DELETE FROM evidence_objects WHERE task_id = $1', [taskId]);
    await pool.query('DELETE FROM approvals WHERE task_id = $1', [taskId]);
    await pool.query('DELETE FROM executions WHERE task_id = $1', [taskId]);
    await pool.query('DELETE FROM tasks WHERE task_id = $1', [taskId]);
    await closePool();
  }
});
