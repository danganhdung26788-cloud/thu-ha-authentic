import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalApprovalError, LocalApprovalStore, localPlanHash } from '../src/local-approval-store.js';
import type { LocalOperationPlan } from '../src/contracts.js';

function plan(content = 'approved'): LocalOperationPlan {
  return {
    objective: 'Write one bounded file.',
    workspaceId: 'test',
    operations: [{ toolId: 'filesystem.write', input: { path: 'out/result.txt', content } }],
    readPaths: ['.'],
    writePaths: ['out'],
  };
}

test('plan hash is deterministic across object key order and changes with content', () => {
  const first = plan('one');
  const reordered = {
    writePaths: ['out'],
    readPaths: ['.'],
    operations: [{ input: { content: 'one', path: 'out/result.txt' }, toolId: 'filesystem.write' }],
    workspaceId: 'test',
    objective: 'Write one bounded file.',
  } as LocalOperationPlan;
  assert.equal(localPlanHash('test', first), localPlanHash('test', reordered));
  assert.notEqual(localPlanHash('test', first), localPlanHash('test', plan('two')));
});

test('approval is single-use and hash-bound', () => {
  let now = Date.parse('2026-08-01T00:00:00.000Z');
  const store = new LocalApprovalStore(300, () => now);
  const grant = store.prepare('test', plan(), undefined, 'prepare-key-001');
  assert.match(grant.approvalId, /^[0-9a-f-]{36}$/u);
  assert.equal(grant.planHash, localPlanHash('test', plan()));
  assert.throws(
    () => store.claim(grant.approvalId, '0'.repeat(64)),
    (error) => error instanceof LocalApprovalError && error.code === 'LOCAL_APPROVAL_HASH_MISMATCH',
  );
  const claimed = store.claim(grant.approvalId, grant.planHash);
  assert.equal(claimed.approvalId, grant.approvalId);
  assert.throws(
    () => store.claim(grant.approvalId, grant.planHash),
    (error) => error instanceof LocalApprovalError && error.code === 'LOCAL_APPROVAL_CONSUMED',
  );
  now += 1;
});

test('expired approval cannot be executed', () => {
  let now = Date.parse('2026-08-01T00:00:00.000Z');
  const store = new LocalApprovalStore(30, () => now);
  const grant = store.prepare('test', plan(), 30, undefined);
  now += 30_001;
  assert.throws(
    () => store.claim(grant.approvalId, grant.planHash),
    (error) => error instanceof LocalApprovalError
      && ['LOCAL_APPROVAL_EXPIRED', 'LOCAL_APPROVAL_NOT_FOUND'].includes(error.code),
  );
});

test('prepare idempotency reuses an active unconsumed grant only', () => {
  const store = new LocalApprovalStore(300, () => Date.parse('2026-08-01T00:00:00.000Z'));
  const first = store.prepare('test', plan(), undefined, 'prepare-key-001');
  const second = store.prepare('test', plan('changed-but-same-request-key'), undefined, 'prepare-key-001');
  assert.deepEqual(second, first);
  store.claim(first.approvalId, first.planHash);
  const third = store.prepare('test', plan('new'), undefined, 'prepare-key-001');
  assert.notEqual(third.approvalId, first.approvalId);
});

test('revocation removes all outstanding approvals', () => {
  const store = new LocalApprovalStore(300);
  const first = store.prepare('test', plan('one'), undefined, undefined);
  store.prepare('test', plan('two'), undefined, undefined);
  assert.equal(store.revokeAll(), 2);
  assert.throws(
    () => store.claim(first.approvalId, first.planHash),
    (error) => error instanceof LocalApprovalError && error.code === 'LOCAL_APPROVAL_NOT_FOUND',
  );
});
