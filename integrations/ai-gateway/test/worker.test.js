import test from 'node:test';
import assert from 'node:assert/strict';
import { selectClaimableRows, validateQueueRow } from '../src/worker.js';

const config = {
  ownerId: 'danganhdung',
  targetWorkspace: '10_CA_NHAN/danganhdung',
  maxBatch: 5,
};

function row(overrides = {}) {
  const value = [
    'Q-1','DAD-20260725-0002','danganhdung','10_CA_NHAN/danganhdung','VALIDATED_READY',
    'ChatGPT','SINGLE_PASS_WITH_CHATGPT_CHECK','FALSE','','manifest-id','','0','3','','','','','corr','now','now',
  ];
  const index = { ownerId: 2, targetWorkspace: 3, status: 4, manifestId: 9, nextRunAt: 13 };
  for (const [key, item] of Object.entries(overrides)) value[index[key]] = item;
  return value;
}

test('accepts a valid owner-scoped queue row', () => {
  assert.deepEqual(validateQueueRow(row(), config), []);
});

test('rejects owner mismatch', () => {
  assert.ok(validateQueueRow(row({ ownerId: 'other' }), config).includes('OWNER_SCOPE_MISMATCH'));
});

test('rejects workspace mismatch', () => {
  assert.ok(validateQueueRow(row({ targetWorkspace: '20_DON_VI/MTTQ' }), config).includes('WORKSPACE_SCOPE_MISMATCH'));
});

test('limits selected work to maxBatch', () => {
  const rows = Array.from({ length: 10 }, () => row());
  assert.equal(selectClaimableRows(rows, { ...config, maxBatch: 3 }).length, 3);
});
