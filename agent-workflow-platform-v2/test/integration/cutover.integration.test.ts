import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { resetEnvForTests } from '../../src/config/env.js';
import { PostgresControlPlaneStore } from '../../src/control-plane/postgres-store.js';
import { CutoverStore } from '../../src/cutover/cutover-store.js';
import { ShadowRunStore } from '../../src/cutover/shadow-store.js';
import { closePool, getPool } from '../../src/db/pool.js';

const integrationEnabled = process.env.RUN_INTEGRATION === '1';

test('cutover state machine blocks skipped and under-evidenced transitions', { skip: !integrationEnabled }, async () => {
  resetEnvForTests();
  const cutover = new CutoverStore();
  const actor = `integration-cutover-${randomUUID()}`;
  try {
    await getPool().query(
      `UPDATE cutover_state SET phase = 'V1_ONLY', changed_by = 'TEST_RESET',
        reason = 'integration reset', rollback_until = NULL, updated_at = now()
       WHERE singleton = true`,
    );
    await assert.rejects(
      cutover.transition({ targetPhase: 'DUAL_RUN', changedBy: actor, reason: 'skip shadow' }),
      /Invalid cutover transition/,
    );
    const shadow = await cutover.transition({
      targetPhase: 'SHADOW',
      changedBy: actor,
      reason: 'begin isolated comparison',
      evidence: { foundationCi: 'PASS' },
    });
    assert.equal(shadow.toPhase, 'SHADOW');
    const dual = await cutover.transition({
      targetPhase: 'DUAL_RUN',
      changedBy: actor,
      reason: 'shadow accepted',
      evidence: { materialMismatch: 0 },
    });
    assert.equal(dual.toPhase, 'DUAL_RUN');
    await assert.rejects(
      cutover.transition({ targetPhase: 'V2_PRIMARY', changedBy: actor, reason: 'missing gates' }),
      /verified backup, owner approval and rollback deadline/,
    );
    const rollbackDeadline = new Date(Date.now() + 24 * 60 * 60_000);
    const primary = await cutover.transition({
      targetPhase: 'V2_PRIMARY',
      changedBy: actor,
      reason: 'approved cutover test',
      rollbackUntil: rollbackDeadline,
      backupVerified: true,
      ownerApproved: true,
      evidence: { uat: 'PASS' },
    });
    assert.equal(primary.toPhase, 'V2_PRIMARY');
    await assert.rejects(
      cutover.transition({
        targetPhase: 'V1_DECOMMISSIONED',
        changedBy: actor,
        reason: 'missing soak',
        backupVerified: true,
        ownerApproved: true,
        rollbackExpired: true,
      }),
      /requires 7\/7 soak/,
    );
  } finally {
    const pool = getPool();
    await pool.query('DELETE FROM cutover_history WHERE changed_by = $1', [actor]);
    await pool.query(
      `UPDATE cutover_state SET phase = 'V1_ONLY', changed_by = 'TEST_RESET',
        reason = 'integration cleanup', rollback_until = NULL, updated_at = now()
       WHERE singleton = true`,
    );
    await closePool();
  }
});

test('shadow comparison is deterministic across object key order', { skip: !integrationEnabled }, async () => {
  resetEnvForTests();
  const tasks = new PostgresControlPlaneStore();
  const shadows = new ShadowRunStore();
  const suffix = randomUUID();
  const taskId = `TASK-SHADOW-${suffix}`;
  const ownerId = `owner-${suffix}`;
  const workspaceId = `workspace-${suffix}`;
  try {
    await tasks.createTask({
      taskId,
      correlationId: `CORR-${suffix}`,
      idempotencyKey: `IDEM-${suffix}`,
      ownerId,
      workspaceId,
      objective: 'Compare V1 and V2 result structures',
      readScope: ['/shadow'],
      writeScope: [],
      autonomyMode: 'READ_ONLY',
      riskLevel: 'LOW',
    });
    const recorded = await shadows.record({
      taskId,
      ownerId,
      workspaceId,
      v1Result: { a: 1, nested: { x: true, y: 'same' } },
      v2Result: { nested: { y: 'same', x: true }, a: 1 },
    });
    assert.equal(recorded.status, 'MATCH');
    const summary = await shadows.summary(ownerId, workspaceId);
    assert.deepEqual(summary, [{ status: 'MATCH', count: 1 }]);
  } finally {
    const pool = getPool();
    await pool.query('DELETE FROM shadow_runs WHERE task_id = $1', [taskId]);
    await pool.query('DELETE FROM outbox_events WHERE aggregate_id = $1', [taskId]);
    await pool.query('DELETE FROM tasks WHERE task_id = $1', [taskId]);
    await closePool();
  }
});
