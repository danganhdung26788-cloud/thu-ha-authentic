import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { resetEnvForTests } from '../../src/config/env.js';
import { PostgresControlPlaneStore } from '../../src/control-plane/postgres-store.js';
import { closePool, getPool } from '../../src/db/pool.js';
import { createTaskQueue, defaultTaskJobId, enqueueTask } from '../../src/queue/task-queue.js';

const integrationEnabled = process.env.RUN_INTEGRATION === '1';

test('PostgreSQL task creation is owner-scoped and idempotent', { skip: !integrationEnabled }, async () => {
  resetEnvForTests();
  const store = new PostgresControlPlaneStore();
  const suffix = randomUUID();
  const firstId = `TASK-${suffix}`;
  const common = {
    correlationId: `CORR-${suffix}`,
    idempotencyKey: `IDEM-${suffix}`,
    ownerId: 'integration-owner',
    workspaceId: 'integration-workspace',
    objective: 'Verify durable task idempotency',
    readScope: ['/integration'],
    writeScope: ['/integration'],
    autonomyMode: 'SANDBOX_HIGH' as const,
    riskLevel: 'LOW' as const,
  };
  try {
    const first = await store.createTask({ ...common, taskId: firstId });
    const replay = await store.createTask({ ...common, taskId: `TASK-REPLAY-${suffix}` });
    assert.equal(first.created, true);
    assert.equal(replay.created, false);
    assert.equal(replay.task.taskId, firstId);
    assert.equal(await store.healthCheck(), true);
  } finally {
    const pool = getPool();
    await pool.query('DELETE FROM outbox_events WHERE aggregate_id = $1', [firstId]);
    await pool.query('DELETE FROM audit_events WHERE task_id = $1', [firstId]);
    await pool.query('DELETE FROM evidence_objects WHERE task_id = $1', [firstId]);
    await pool.query('DELETE FROM approvals WHERE task_id = $1', [firstId]);
    await pool.query('DELETE FROM executions WHERE task_id = $1', [firstId]);
    await pool.query('DELETE FROM tasks WHERE task_id = $1', [firstId]);
    await closePool();
  }
});

test('Redis queue accepts deterministic owner-scoped job IDs', { skip: !integrationEnabled }, async () => {
  resetEnvForTests();
  const queue = createTaskQueue();
  const suffix = randomUUID();
  const data = {
    taskId: `TASK:${suffix}`,
    ownerId: 'owner:test',
    workspaceId: 'workspace:test',
    correlationId: `CORR-${suffix}`,
  };
  try {
    await enqueueTask(queue, data);
    const jobId = defaultTaskJobId(data);
    assert.equal(jobId.includes(':'), false);
    const job = await queue.getJob(jobId);
    assert.equal(job?.data.taskId, data.taskId);
  } finally {
    await queue.obliterate({ force: true });
    await queue.close();
  }
});
