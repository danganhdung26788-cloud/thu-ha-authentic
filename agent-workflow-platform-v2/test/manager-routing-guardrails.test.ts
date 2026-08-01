import assert from 'node:assert/strict';
import test from 'node:test';
import { compileChatTask } from '../src/chat/task-compiler.js';
import type { ExecutionContext } from '../src/contracts/execution-context.js';
import { extractJsonObject } from '../src/models/local-json.js';
import {
  deterministicRoutingHint,
  normalizeManagerDecision,
} from '../src/runtime/manager-routing-guardrails.js';
import { ROUTING_SCENARIOS } from '../src/benchmark/routing-scenarios.js';

const dummyDecision = {
  executor: 'CHATGPT',
  rationale: 'Local model semantic summary.',
  nextAction: 'Continue inside the registered scope.',
  requestedTools: ['specialist.analyze'],
  toolCalls: [],
  requiresApproval: false,
} as const;

test('deterministic routing authority covers all 100 acceptance scenarios', () => {
  for (const scenario of ROUTING_SCENARIOS) {
    const compiled = compileChatTask(scenario.prompt, []);
    const context: ExecutionContext = {
      taskId: `TEST-${scenario.id}`,
      correlationId: `CORR-${scenario.id}`,
      ownerId: 'danganhdung',
      workspaceId: 'workflow-v2-sandbox',
      readScope: compiled.readScope,
      writeScope: compiled.writeScope,
      autonomyMode: compiled.autonomyMode,
      riskLevel: compiled.riskLevel,
    };
    const hint = deterministicRoutingHint(scenario.prompt, context);
    const normalized = normalizeManagerDecision(dummyDecision, scenario.prompt, context);
    assert.equal(hint.executor, scenario.expectedExecutor, `${scenario.id} deterministic hint executor`);
    assert.equal(normalized.executor, scenario.expectedExecutor, `${scenario.id} normalized executor`);
    assert.equal(normalized.requiresApproval, scenario.expectApproval, `${scenario.id} approval`);
    assert.equal(Boolean(normalized.clarification), scenario.expectClarification, `${scenario.id} clarification`);
  }
});

test('local JSON extraction removes thinking and Markdown wrappers', () => {
  const value = extractJsonObject('<think>hidden reasoning</think>```json\n{"ok":true}\n```');
  assert.deepEqual(value, { ok: true });
});
