import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EXPECTED_HEADERS,
  assertHeader,
  buildHeartbeatRow,
  buildHermesPrompt,
  executionRow,
  normalizeDispatchError,
  parseHermesResult,
  selectClaimableRows,
  shouldSkipForIdempotency,
  staleRecovery,
  validateQueueRow,
} from '../src/worker.js';

const config = {
  ownerId: 'danganhdung',
  targetWorkspace: '10_CA_NHAN/danganhdung',
  maxBatch: 5,
  staleLockMs: 1000,
};

function row(overrides = {}) {
  const value = [
    'Q-1','DAD-20260725-0002','danganhdung','10_CA_NHAN/danganhdung','VALIDATED_READY',
    'Hermes','SINGLE_PASS','FALSE','','manifest-id','','0','3','','','','','corr','now','now',
  ];
  const index = {
    ownerId: 2, targetWorkspace: 3, status: 4, primaryAi: 5,
    manifestId: 9, nextRunAt: 13, claimedAt: 14,
  };
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
  assert.equal(selectClaimableRows(Array.from({ length: 8 }, () => row()), { ...config, maxBatch: 3 }).length, 3);
});

test('builds prompt with resolved manifest content', () => {
  const prompt = buildHermesPrompt({
    queueId: 'Q', taskId: 'T', ownerId: 'danganhdung',
    targetWorkspace: '10_CA_NHAN/danganhdung', approvalRequired: false,
    manifestId: 'M', manifestText: 'SAFE_MANIFEST',
  });
  assert.match(prompt, /MANIFEST_CONTENT:\nSAFE_MANIFEST/);
  assert.match(prompt, /HANDOFF_REQUIRED: CHATGPT/);
});

test('recovers stale RUNNING lock to RETRY_WAIT', () => {
  const stale = row({ status: 'RUNNING', claimedAt: new Date(Date.now() - 5000).toISOString() });
  const recovered = staleRecovery([stale], config);
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].row[4], 'RETRY_WAIT');
  assert.equal(recovered[0].row[10], '');
  assert.equal(recovered[0].row[16], 'STALE_LOCK_RECOVERED');
});

test('does not recover fresh lock', () => {
  const fresh = row({ status: 'RUNNING', claimedAt: new Date().toISOString() });
  assert.equal(staleRecovery([fresh], config).length, 0);
});

test('schema contract accepts exact execution header', () => {
  assert.equal(assertHeader(EXPECTED_HEADERS.EXECUTIONS, EXPECTED_HEADERS.EXECUTIONS, 'EXECUTIONS'), true);
});

test('schema contract rejects changed header', () => {
  assert.throws(() => assertHeader(['BAD'], EXPECTED_HEADERS.EXECUTIONS, 'EXECUTIONS'), /schema mismatch/);
});

test('execution row aligns with 16 live columns', () => {
  const values = executionRow({
    executionId: 'E', taskId: 'T', adapterId: 'A', attemptNo: 1,
    status: 'SUCCESS', startedAt: 'S', finishedAt: 'F',
  });
  assert.equal(values.length, 16);
  assert.equal(values[0], 'E');
  assert.equal(values[6], 'SUCCESS');
});

test('idempotency detects existing successful execution', () => {
  const rows = [EXPECTED_HEADERS.EXECUTIONS, ['E', 'T', '', '', '', '', 'SUCCESS']];
  assert.equal(shouldSkipForIdempotency(rows, 'T'), true);
  assert.equal(shouldSkipForIdempotency(rows, 'OTHER'), false);
});

test('parses ChatGPT handoff request', () => {
  const result = parseHermesResult('HANDOFF_REQUIRED: CHATGPT\nRESULT_URI: gdrive://x');
  assert.equal(result.handoffRequired, true);
  assert.equal(result.resultUri, 'gdrive://x');
});

test('normalizes AbortSignal timeout to HERMES_TIMEOUT', () => {
  const error = new Error('timeout');
  error.name = 'TimeoutError';
  assert.equal(normalizeDispatchError(error).code, 'HERMES_TIMEOUT');
});
test('normalizes DNS lookup failure to HERMES_DNS_ERROR', () => {
  const error = new TypeError('fetch failed');
  error.cause = { code: 'ENOTFOUND' };
  assert.equal(normalizeDispatchError(error).code, 'HERMES_DNS_ERROR');
});

test('builds DEGRADED heartbeat when a cycle reports an error', () => {
  const heartbeat = buildHeartbeatRow(
    { workerVersion: '0.4.0', workerCommit: 'test' },
    { queueDepth: 1, lastError: 'HERMES_DNS_ERROR' },
    '2026-07-26T06:00:00.000Z',
  );
  assert.equal(heartbeat[4], 'ALIVE');
  assert.equal(heartbeat[5], 'DEGRADED');
  assert.equal(heartbeat[6], 'FAIL');
  assert.equal(heartbeat[9], 'HERMES_DNS_ERROR');
});

test('builds ALIVE heartbeat after recovery', () => {
  const heartbeat = buildHeartbeatRow(
    { workerVersion: '0.4.0', workerCommit: 'test' },
    { queueDepth: 0, lastError: '' },
    '2026-07-26T06:01:00.000Z',
  );
  assert.equal(heartbeat[4], 'ALIVE');
  assert.equal(heartbeat[5], 'ALIVE');
  assert.equal(heartbeat[6], 'PASS');
  assert.equal(heartbeat[9], '');
});
