import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExecutionContext } from '../src/contracts/execution-context.js';
import { evaluateActionPolicy } from '../src/policy/policy-engine.js';

const context: ExecutionContext = {
  taskId: 'DAD-V2-0001',
  correlationId: 'CORR-DAD-V2-0001',
  ownerId: 'danganhdung',
  workspaceId: 'sandbox-danganhdung',
  readScope: ['D:/AgentWorkflowV2/workspaces/danganhdung'],
  writeScope: ['D:/AgentWorkflowV2/workspaces/danganhdung'],
  autonomyMode: 'SANDBOX_HIGH',
  riskLevel: 'LOW',
};

test('auto-approves a bounded sandbox mutation', () => {
  const decision = evaluateActionPolicy(context, {
    action: 'run npm test',
    mutating: true,
    target: 'D:/AgentWorkflowV2/workspaces/danganhdung/repo',
  });

  assert.equal(decision.outcome, 'AUTO_APPROVE');
});

test('denies a target outside write scope', () => {
  const decision = evaluateActionPolicy(context, {
    action: 'modify foreign workspace',
    mutating: true,
    target: 'D:/OtherOwner/workspace',
  });

  assert.equal(decision.outcome, 'DENY');
});

test('requires approval for production mutation', () => {
  const decision = evaluateActionPolicy(context, {
    action: 'deploy production',
    mutating: true,
    target: 'D:/AgentWorkflowV2/workspaces/danganhdung/repo',
    touchesProduction: true,
  });

  assert.equal(decision.outcome, 'REQUIRE_APPROVAL');
});

test('requires approval for destructive action without verified backup', () => {
  const decision = evaluateActionPolicy(context, {
    action: 'delete runtime data',
    mutating: true,
    target: 'D:/AgentWorkflowV2/workspaces/danganhdung/runtime',
    destructive: true,
    backupVerified: false,
  });

  assert.equal(decision.outcome, 'REQUIRE_APPROVAL');
});
