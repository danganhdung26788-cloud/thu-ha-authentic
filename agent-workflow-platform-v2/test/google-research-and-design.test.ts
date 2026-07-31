import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExecutorRequest } from '../src/executors/contracts.js';
import { GeminiExecutorAdapter } from '../src/executors/gemini-adapter.js';
import { NotebookLmSourcePackageAdapter } from '../src/executors/notebooklm-adapter.js';

function request(executor: ExecutorRequest['executor'], requestedTools: string[]): ExecutorRequest {
  return {
    context: {
      taskId: 'TASK-GOOGLE-001',
      correlationId: 'CORR-GOOGLE-001',
      ownerId: 'danganhdung',
      workspaceId: 'sandbox-google-tools',
      readScope: ['drive://approved-source-1', 'drive://approved-source-2'],
      writeScope: ['evidence://google-tools'],
      autonomyMode: 'SANDBOX_HIGH',
      riskLevel: 'LOW',
    },
    executor,
    objective: 'Cross-check the approved source set.',
    instructions: 'Identify agreements, conflicts and missing evidence.',
    requestedTools,
  };
}

test('Gemini adapter executes through an injected bounded client', async () => {
  const calls: Array<{ model: string; contents: string }> = [];
  const adapter = new GeminiExecutorAdapter({
    apiKey: '',
    model: 'gemini-test-model',
    client: {
      async generate(input) {
        calls.push(input);
        return 'Grounded cross-check result.';
      },
    },
  });

  const result = await adapter.execute(request('GEMINI', ['gemini.cross-check']));
  assert.equal(result.status, 'SUCCEEDED');
  assert.equal(result.output.model, 'gemini-test-model');
  assert.equal(result.output.text, 'Grounded cross-check result.');
  assert.equal(calls.length, 1);
  assert.match(calls[0]?.contents ?? '', /TASK-GOOGLE-001/);
  assert.match(calls[0]?.contents ?? '', /drive:\/\/approved-source-1/);
});

test('Gemini adapter rejects tools from another executor', async () => {
  const adapter = new GeminiExecutorAdapter({
    apiKey: '',
    model: 'gemini-test-model',
    client: { async generate() { return 'unused'; } },
  });
  const result = await adapter.execute(request('GEMINI', ['filesystem.write']));
  assert.equal(result.status, 'FAILED');
  assert.equal(result.errorCode, 'GEMINI_TOOL_NOT_ALLOWED');
});

test('NotebookLM adapter creates a private source-grounded handoff package', async () => {
  const adapter = new NotebookLmSourcePackageAdapter();
  const result = await adapter.execute(
    request('NOTEBOOKLM', ['notebooklm.prepare-source-package']),
  );
  assert.equal(result.status, 'HANDOFF');
  assert.equal(result.output.mode, 'SOURCE_PACKAGE_ONLY');
  assert.deepEqual(
    (result.output.sourceManifest as Array<{ source: string }>).map((item) => item.source),
    ['drive://approved-source-1', 'drive://approved-source-2'],
  );
  assert.match(JSON.stringify(result.output.restrictions), /Do not make the notebook public/);
});
