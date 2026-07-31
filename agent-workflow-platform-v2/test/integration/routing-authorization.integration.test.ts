import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExecutionContext, ManagerDecision } from '../../src/contracts/execution-context.js';
import { resetEnvForTests } from '../../src/config/env.js';
import { closePool } from '../../src/db/pool.js';
import { authorizeManagerTools } from '../../src/registry/routing-authorization.js';

const integrationEnabled = process.env.RUN_INTEGRATION === '1';

const context: ExecutionContext = {
  taskId: 'TASK-ROUTE-AUTH',
  correlationId: 'CORR-ROUTE-AUTH',
  ownerId: 'routing-owner',
  workspaceId: 'routing-workspace',
  readScope: ['/routing'],
  writeScope: ['/routing'],
  autonomyMode: 'SANDBOX_HIGH',
  riskLevel: 'LOW',
};

function manager(executor: ManagerDecision['executor'], tool: string): ManagerDecision {
  return {
    executor,
    rationale: 'Integration routing authorization test.',
    nextAction: 'Execute the registered bounded tool.',
    requestedTools: [tool],
    requiresApproval: false,
  };
}

test('registered tool risk drives deterministic mutation and deep intervention policy', { skip: !integrationEnabled }, async () => {
  resetEnvForTests();
  try {
    const scheduledTask = await authorizeManagerTools(
      context,
      manager('HERMES', 'scheduled-task.manage'),
    );
    assert.equal(scheduledTask.mutating, true);
    assert.equal(scheduledTask.deepIntervention, false);

    const deploy = await authorizeManagerTools(
      context,
      manager('CODEX', 'deploy.execute'),
    );
    assert.equal(deploy.mutating, true);
    assert.equal(deploy.deepIntervention, true);

    await assert.rejects(
      authorizeManagerTools(context, manager('HERMES', 'code.modify')),
      /Tool grant denied/,
    );
  } finally {
    await closePool();
  }
});
