import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { getConfig, resetConfigForTests } from '../src/config.js';
import { DelegationService } from '../src/delegation-service.js';
import { WorkspaceRegistry } from '../src/workspace-registry.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'delegation-local-executor-'));
  await mkdir(join(root, 'out'), { recursive: true });
  resetConfigForTests();
  const config = getConfig({
    NODE_ENV: 'test',
    CODEX_ENABLED: 'false',
    LOCAL_EXECUTOR_ENABLED: 'true',
    LOCAL_APPROVAL_TTL_SECONDS: '300',
    SPECIALIST_AGENT_ENABLED: 'false',
  });
  const workspaces = WorkspaceRegistry.fromDocument({
    defaultWorkspaceId: 'test',
    workspaces: [{
      workspaceId: 'test',
      root,
      readRoots: ['.'],
      writeRoots: ['out'],
      allowedExecutables: [],
      allowedScripts: [],
      scheduledTaskPrefix: 'TEST-',
      allowCodexRead: false,
      allowLocalRead: true,
      allowLocalWrite: true,
    }],
  });
  return { root, service: new DelegationService(config, workspaces) };
}

async function prepareWrite(
  service: DelegationService,
  path: string,
  content: string,
  prepareKey: string,
) {
  const prepared = await service.prepareLocalOperations({
    objective: `Write ${path}.`,
    workspaceId: 'test',
    operations: [{ toolId: 'filesystem.write', input: { path, content, encoding: 'utf8' } }],
    readPaths: ['.'],
    writePaths: ['out'],
    idempotencyKey: prepareKey,
  });
  assert.equal(prepared.status, 'SUCCEEDED');
  return {
    approvalId: prepared.result.approvalId as string,
    planHash: prepared.result.planHash as string,
  };
}

test('local executor writes only after exact plan preparation and read-back', async () => {
  const { root, service } = await fixture();
  try {
    const approval = await prepareWrite(service, 'out/result.txt', 'approved-content', 'prepare-write-001');
    assert.equal(await readFile(join(root, 'out', 'result.txt'), 'utf8').catch(() => ''), '');
    const result = await service.executeApprovedLocalOperations({
      ...approval,
      idempotencyKey: 'execute-write-001',
    });
    assert.equal(result.status, 'SUCCEEDED');
    assert.equal(result.target, 'LOCAL_EXECUTOR');
    assert.equal(await readFile(join(root, 'out', 'result.txt'), 'utf8'), 'approved-content');
    const action = (result.result.actions as Array<Record<string, unknown>>)[0];
    assert.equal(action?.readBackVerified, true);
  } finally {
    await rm(root, { recursive: true, force: true });
    resetConfigForTests();
  }
});

test('plan preparation rejects path escape before an approval exists', async () => {
  const { root, service } = await fixture();
  try {
    await assert.rejects(
      () => service.prepareLocalOperations({
        objective: 'Attempt an invalid write.',
        workspaceId: 'test',
        operations: [{ toolId: 'filesystem.write', input: { path: '../escape.txt', content: 'blocked' } }],
        readPaths: ['.'],
        writePaths: ['out'],
        idempotencyKey: 'prepare-escape-001',
      }),
      /outside|allowlisted|scope/iu,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    resetConfigForTests();
  }
});

test('plan preparation rejects an existing symlink path that escapes the workspace', {
  skip: process.platform === 'win32',
}, async () => {
  const { root, service } = await fixture();
  const outside = await mkdtemp(join(tmpdir(), 'delegation-local-executor-outside-'));
  try {
    await symlink(outside, join(root, 'out', 'linked-outside'), 'dir');
    await assert.rejects(
      () => service.prepareLocalOperations({
        objective: 'Attempt a write through a linked directory.',
        workspaceId: 'test',
        operations: [{ toolId: 'filesystem.write', input: { path: 'out/linked-outside/escape.txt', content: 'blocked' } }],
        readPaths: ['.'],
        writePaths: ['out'],
        idempotencyKey: 'prepare-symlink-001',
      }),
      /symbolic|junction|escape/iu,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
    resetConfigForTests();
  }
});

test('same execution idempotency key returns original result without a second write', async () => {
  const { root, service } = await fixture();
  try {
    const approval = await prepareWrite(service, 'out/idempotent.txt', 'first', 'prepare-idempotent-001');
    const first = await service.executeApprovedLocalOperations({ ...approval, idempotencyKey: 'execute-idempotent-001' });
    const second = await service.executeApprovedLocalOperations({ ...approval, idempotencyKey: 'execute-idempotent-001' });
    assert.deepEqual(second, first);
    assert.equal(await readFile(join(root, 'out', 'idempotent.txt'), 'utf8'), 'first');
  } finally {
    await rm(root, { recursive: true, force: true });
    resetConfigForTests();
  }
});

test('consumed approval is blocked when replayed with a different idempotency key', async () => {
  const { root, service } = await fixture();
  try {
    const approval = await prepareWrite(service, 'out/single-use.txt', 'once', 'prepare-single-use-001');
    const first = await service.executeApprovedLocalOperations({ ...approval, idempotencyKey: 'execute-single-use-001' });
    assert.equal(first.status, 'SUCCEEDED');
    const replay = await service.executeApprovedLocalOperations({ ...approval, idempotencyKey: 'execute-single-use-002' });
    assert.equal(replay.status, 'BLOCKED');
    assert.equal(replay.errorCode, 'LOCAL_APPROVAL_CONSUMED');
  } finally {
    await rm(root, { recursive: true, force: true });
    resetConfigForTests();
  }
});

test('wrong plan hash is blocked without consuming the approval', async () => {
  const { root, service } = await fixture();
  try {
    const approval = await prepareWrite(service, 'out/hash.txt', 'hash-bound', 'prepare-hash-001');
    const wrong = await service.executeApprovedLocalOperations({
      approvalId: approval.approvalId,
      planHash: '0'.repeat(64),
      idempotencyKey: 'execute-hash-wrong-001',
    });
    assert.equal(wrong.status, 'BLOCKED');
    assert.equal(wrong.errorCode, 'LOCAL_APPROVAL_HASH_MISMATCH');
    const correct = await service.executeApprovedLocalOperations({ ...approval, idempotencyKey: 'execute-hash-correct-001' });
    assert.equal(correct.status, 'SUCCEEDED');
  } finally {
    await rm(root, { recursive: true, force: true });
    resetConfigForTests();
  }
});

test('same external idempotency key is isolated between inspection and approved execution', async () => {
  const { root, service } = await fixture();
  try {
    const inspection = await service.inspectLocalRuntime({
      workspaceId: 'test',
      kind: 'system',
      idempotencyKey: 'shared-tool-key-001',
    });
    assert.equal(inspection.status, 'SUCCEEDED');
    const approval = await prepareWrite(service, 'out/namespaced.txt', 'namespaced-result', 'prepare-namespaced-001');
    const mutation = await service.executeApprovedLocalOperations({ ...approval, idempotencyKey: 'shared-tool-key-001' });
    assert.equal(mutation.status, 'SUCCEEDED');
    assert.equal(await readFile(join(root, 'out', 'namespaced.txt'), 'utf8'), 'namespaced-result');
  } finally {
    await rm(root, { recursive: true, force: true });
    resetConfigForTests();
  }
});
