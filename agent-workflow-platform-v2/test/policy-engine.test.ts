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

test('denies Windows path traversal outside registered scope', () => {
  const decision = evaluateActionPolicy(context, {
    action: 'escape workspace',
    mutating: true,
    target: 'D:/AgentWorkflowV2/workspaces/danganhdung/../other-owner',
  });
  assert.equal(decision.outcome, 'DENY');
});

test('denies a mutating action without an explicit target', () => {
  const decision = evaluateActionPolicy(context, {
    action: 'run an unspecified write',
    mutating: true,
  });
  assert.equal(decision.outcome, 'DENY');
});

test('denies resource URIs containing embedded credentials', () => {
  const uriContext: ExecutionContext = {
    ...context,
    readScope: ['https://example.com/data'],
    writeScope: [],
  };
  const decision = evaluateActionPolicy(uriContext, {
    action: 'read remote source',
    target: 'https://user:password@example.com/data',
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

test('requires approval for a registered deep-intervention tool', () => {
  const decision = evaluateActionPolicy(context, {
    action: 'deploy through registered tool',
    mutating: true,
    target: 'D:/AgentWorkflowV2/workspaces/danganhdung/repo',
    deepToolRequested: true,
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
