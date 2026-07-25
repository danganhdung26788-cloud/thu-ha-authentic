import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildHermesPrompt,
  normalizeDispatchError,
  runCycle,
  selectClaimableRows,
  validateQueueRow,
} from '../src/worker.js';

const config = {
  spreadsheetId: 'sheet-id',
  ownerId: 'danganhdung',
  targetWorkspace: '10_CA_NHAN/danganhdung',
  maxBatch: 5,
};

function row(overrides = {}) {
  const value = [
    'Q-1','DAD-20260725-0002','danganhdung','10_CA_NHAN/danganhdung','VALIDATED_READY',
    'Hermes','SINGLE_PASS_WITH_CHATGPT_CHECK','FALSE','','manifest-id','','0','3','','','','','corr','now','now',
  ];
  const index = { ownerId: 2, targetWorkspace: 3, status: 4, primaryAi: 5, manifestId: 9, nextRunAt: 13 };
  for (const [key, item] of Object.entries(overrides)) value[index[key]] = item;
  return value;
}

test('accepts a valid owner-scoped Hermes queue row', () => {
  assert.deepEqual(validateQueueRow(row(), config), []);
});

test('rejects owner mismatch', () => {
  assert.ok(validateQueueRow(row({ ownerId: 'other' }), config).includes('OWNER_SCOPE_MISMATCH'));
});

test('rejects workspace mismatch', () => {
  assert.ok(validateQueueRow(row({ targetWorkspace: '20_DON_VI/MTTQ' }), config).includes('WORKSPACE_SCOPE_MISMATCH'));
});

test('rejects queue items routed to ChatGPT', () => {
  assert.ok(validateQueueRow(row({ primaryAi: 'ChatGPT' }), config).includes('PRIMARY_AI_NOT_HERMES'));
});

test('accepts canonical AI-HERMES identifier', () => {
  assert.deepEqual(validateQueueRow(row({ primaryAi: 'AI-HERMES' }), config), []);
});

test('limits selected work to maxBatch', () => {
  const rows = Array.from({ length: 10 }, () => row());
  assert.equal(selectClaimableRows(rows, { ...config, maxBatch: 3 }).length, 3);
});

test('builds a manifest-scoped Hermes prompt', () => {
  const prompt = buildHermesPrompt({
    queueId: 'Q-1', taskId: 'DAD-1', ownerId: 'danganhdung',
    targetWorkspace: '10_CA_NHAN/danganhdung', primaryAi: 'Hermes',
    reviewMode: 'SINGLE_PASS', approvalRequired: false,
    taskFolderId: 'folder', manifestId: 'manifest', correlationId: 'corr',
  });
  assert.match(prompt, /TASK_ID: DAD-1/);
  assert.match(prompt, /MANIFEST_ID: manifest/);
  assert.match(prompt, /RESULT_URI:/);
});

test('dry-run is read-only and reports claimable rows', async () => {
  let writes = 0;
  const sheets = {
    spreadsheets: {
      values: {
        get: async () => ({ data: { values: [row()] } }),
        update: async () => { writes += 1; },
        append: async () => { writes += 1; },
      },
    },
  };

  const result = await runCycle(sheets, { ...config, dryRun: true });
  assert.deepEqual(result, { processed: 0, claimable: 1 });
  assert.equal(writes, 0);
});

test('normalizes AbortSignal timeout to HERMES_TIMEOUT', () => {
  const error = new Error('The operation was aborted due to timeout');
  error.name = 'TimeoutError';
  assert.equal(normalizeDispatchError(error).code, 'HERMES_TIMEOUT');
});
