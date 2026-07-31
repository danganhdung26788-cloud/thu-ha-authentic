import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExecutionContext, ManagerDecision } from '../../src/contracts/execution-context.js';
import { resetEnvForTests } from '../../src/config/env.js';
import { closePool } from '../../src/db/pool.js';
import { authorizeManagerTools } from '../../src/registry/routing-authorization.js';

const integrationEnabled = process.env.RUN_INTEGRATION === '1';

const context: ExecutionContext = {
  taskId: 'TASK-GOOGLE-DESIGN-ROUTING',
  correlationId: 'CORR-GOOGLE-DESIGN-ROUTING',
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
    rationale: 'Verify conditional specialist routing.',
    nextAction: 'Authorize the registered specialist tool.',
    requestedTools: [tool],
    requiresApproval: false,
  };
}

test('NotebookLM source packaging is active while Gemini and Canva remain testing', { skip: !integrationEnabled }, async () => {
  resetEnvForTests();
  try {
    const notebook = await authorizeManagerTools(
      context,
      manager('NOTEBOOKLM', 'notebooklm.prepare-source-package'),
    );
    assert.equal(notebook.agentId, 'notebooklm');
    assert.equal(notebook.mutating, false);
    assert.equal(notebook.deepIntervention, false);

    await assert.rejects(
      authorizeManagerTools(context, manager('GEMINI', 'gemini.analyze')),
      /Tool grant denied/,
    );
    await assert.rejects(
      authorizeManagerTools(context, manager('CANVA', 'canva.design.create')),
      /Tool grant denied/,
    );
  } finally {
    await closePool();
  }
});
