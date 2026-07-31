import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { resetEnvForTests } from '../../src/config/env.js';
import { PostgresControlPlaneStore } from '../../src/control-plane/postgres-store.js';
import { claimTaskForExecution } from '../../src/control-plane/task-claim.js';
import { closePool, getPool } from '../../src/db/pool.js';

const integrationEnabled = process.env.RUN_INTEGRATION === '1';

test('PostgreSQL task claim allows only one concurrent execution attempt', { skip: !integrationEnabled }, async () => {
  resetEnvForTests();
  const store = new PostgresControlPlaneStore();
  const suffix = randomUUID();
  const taskId = `TASK-CLAIM-${suffix}`;
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
      objective: 'Verify atomic claim behavior',
      readScope: ['/claim'],
      writeScope: ['/claim'],
      autonomyMode: 'SANDBOX_HIGH',
      riskLevel: 'LOW',
      maxAttempts: 2,
    });

    const [first, second] = await Promise.all([
      claimTaskForExecution(envelope),
      claimTaskForExecution(envelope),
    ]);
    const claimed = [first, second].filter((item) => item.claimed);
    const skipped = [first, second].filter((item) => !item.claimed);
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0]?.task.attempt, 1);
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0]?.task.status, 'RUNNING');

    await store.updateTaskStatus(taskId, 'RETRY_WAIT', {
      attempt: 1,
      nextRunAt: new Date(Date.now() - 1_000),
      lastError: 'integration retry',
    });
    const retry = await claimTaskForExecution(envelope);
    assert.equal(retry.claimed, true);
    assert.equal(retry.task.attempt, 2);

    await store.updateTaskStatus(taskId, 'RETRY_WAIT', {
      attempt: 2,
      nextRunAt: new Date(Date.now() - 1_000),
      lastError: 'attempt exhausted',
    });
    const exhausted = await claimTaskForExecution(envelope);
    assert.equal(exhausted.claimed, false);
    assert.equal(exhausted.task.status, 'FAILED');
    assert.equal(exhausted.task.lastError, 'MAX_ATTEMPTS_EXHAUSTED');
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
