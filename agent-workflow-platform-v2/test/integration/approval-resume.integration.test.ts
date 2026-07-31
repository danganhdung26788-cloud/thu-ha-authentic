import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { resetEnvForTests } from '../../src/config/env.js';
import { consumeApprovedAction } from '../../src/control-plane/approval-resume.js';
import { PostgresControlPlaneStore } from '../../src/control-plane/postgres-store.js';
import { closePool, getPool } from '../../src/db/pool.js';

const integrationEnabled = process.env.RUN_INTEGRATION === '1';

test('approved action is resumed exactly once', { skip: !integrationEnabled }, async () => {
  resetEnvForTests();
  const store = new PostgresControlPlaneStore();
  const suffix = randomUUID();
  const taskId = `TASK-APPROVAL-${suffix}`;
  const approvalId = `APR-${suffix}`;
  try {
    await store.createTask({
      taskId,
      correlationId: `CORR-${suffix}`,
      idempotencyKey: `IDEM-${suffix}`,
      ownerId: 'approval-owner',
      workspaceId: 'approval-workspace',
      objective: 'Execute a bounded approved action',
      readScope: ['/approval'],
      writeScope: ['/approval'],
      autonomyMode: 'SANDBOX_HIGH',
      riskLevel: 'HIGH',
    });
    await store.updateTaskStatus(taskId, 'WAITING_APPROVAL');
    await store.createApproval({
      approvalId,
      taskId,
      ownerId: 'approval-owner',
      workspaceId: 'approval-workspace',
      action: {
        manager: {
          executor: 'HERMES',
          rationale: 'PowerShell execution belongs to Hermes.',
          nextAction: 'Run the approved bounded command.',
          requestedTools: ['powershell.execute'],
          requiresApproval: true,
        },
        policy: {
          outcome: 'REQUIRE_APPROVAL',
          reason: 'Deep intervention test.',
        },
        actionRequest: {
          action: 'Run the approved bounded command.',
          mutating: true,
          target: '/approval',
        },
      },
    });
    await store.decideApproval({
      approvalId,
      decision: 'APPROVED',
      actor: 'integration-test',
    });
    const first = await consumeApprovedAction(taskId);
    assert.equal(first?.approvalId, approvalId);
    assert.equal(first?.action.manager.executor, 'HERMES');
    assert.equal(await consumeApprovedAction(taskId), null);
  } finally {
    const pool = getPool();
    await pool.query('DELETE FROM outbox_events WHERE aggregate_id = $1', [taskId]);
    await pool.query('DELETE FROM approvals WHERE task_id = $1', [taskId]);
    await pool.query('DELETE FROM executions WHERE task_id = $1', [taskId]);
    await pool.query('DELETE FROM tasks WHERE task_id = $1', [taskId]);
    await closePool();
  }
});
