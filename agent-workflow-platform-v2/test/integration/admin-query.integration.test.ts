import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { AdminQueryService } from '../../src/apps/api/admin-query.service.js';
import { PostgresControlPlaneStore } from '../../src/control-plane/postgres-store.js';
import { closePool, getPool } from '../../src/db/pool.js';

const integrationEnabled = process.env.RUN_INTEGRATION === '1';

test('admin task list filters owner and workspace', { skip: !integrationEnabled }, async () => {
  const suffix = randomUUID();
  const store = new PostgresControlPlaneStore();
  const admin = new AdminQueryService();
  const taskA = `TASK-ADMIN-A-${suffix}`;
  const taskB = `TASK-ADMIN-B-${suffix}`;
  try {
    await store.createTask({
      taskId: taskA,
      correlationId: `CORR-A-${suffix}`,
      idempotencyKey: `IDEM-A-${suffix}`,
      ownerId: `owner-a-${suffix}`,
      workspaceId: `workspace-a-${suffix}`,
      objective: 'Visible only in owner A workspace A',
      readScope: ['/admin-a'],
      writeScope: [],
      autonomyMode: 'READ_ONLY',
      riskLevel: 'LOW',
      payload: {},
      maxAttempts: 1,
    });
    await store.createTask({
      taskId: taskB,
      correlationId: `CORR-B-${suffix}`,
      idempotencyKey: `IDEM-B-${suffix}`,
      ownerId: `owner-b-${suffix}`,
      workspaceId: `workspace-b-${suffix}`,
      objective: 'Must not cross into owner A',
      readScope: ['/admin-b'],
      writeScope: [],
      autonomyMode: 'READ_ONLY',
      riskLevel: 'LOW',
      payload: {},
      maxAttempts: 1,
    });

    const result = await admin.listTasks({
      ownerId: `owner-a-${suffix}`,
      workspaceId: `workspace-a-${suffix}`,
      limit: 20,
    });
    const items = result.items as Array<{ taskId: string }>;
    assert.deepEqual(items.map((item) => item.taskId), [taskA]);
    const details = await admin.taskDetails(taskA);
    assert.equal((details?.task as { taskId: string }).taskId, taskA);
  } finally {
    const pool = getPool();
    for (const taskId of [taskA, taskB]) {
      await pool.query('DELETE FROM outbox_events WHERE aggregate_id = $1', [taskId]);
      await pool.query('DELETE FROM audit_events WHERE task_id = $1', [taskId]);
      await pool.query('DELETE FROM evidence_objects WHERE task_id = $1', [taskId]);
      await pool.query('DELETE FROM approvals WHERE task_id = $1', [taskId]);
      await pool.query('DELETE FROM executions WHERE task_id = $1', [taskId]);
      await pool.query('DELETE FROM tasks WHERE task_id = $1', [taskId]);
    }
    await closePool();
  }
});
