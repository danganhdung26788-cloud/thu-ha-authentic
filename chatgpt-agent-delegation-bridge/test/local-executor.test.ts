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

test('local executor writes only inside registered and request scopes with read-back', async () => {
  const { root, service } = await fixture();
  try {
    const result = await service.executeLocalOperations({
      objective: 'Write one approved test file.',
      workspaceId: 'test',
      operations: [{
        toolId: 'filesystem.write',
        input: { path: 'out/result.txt', content: 'approved-content', encoding: 'utf8' },
      }],
      readPaths: ['.'],
      writePaths: ['out'],
      idempotencyKey: 'local-write-001',
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

test('local executor rejects path escape and does not write outside workspace', async () => {
  const { root, service } = await fixture();
  try {
    const result = await service.executeLocalOperations({
      objective: 'Attempt an invalid write.',
      workspaceId: 'test',
      operations: [{
        toolId: 'filesystem.write',
        input: { path: '../escape.txt', content: 'blocked' },
      }],
      readPaths: ['.'],
      writePaths: ['out'],
      idempotencyKey: 'local-write-escape-001',
    });
    assert.equal(result.status, 'FAILED');
    assert.match(result.summary, /outside|allowlisted|scope/iu);
  } finally {
    await rm(root, { recursive: true, force: true });
    resetConfigForTests();
  }
});

test('local executor rejects an existing symlink path that escapes the workspace', {
  skip: process.platform === 'win32',
}, async () => {
  const { root, service } = await fixture();
  const outside = await mkdtemp(join(tmpdir(), 'delegation-local-executor-outside-'));
  try {
    await symlink(outside, join(root, 'out', 'linked-outside'), 'dir');
    const result = await service.executeLocalOperations({
      objective: 'Attempt a write through a linked directory.',
      workspaceId: 'test',
      operations: [{
        toolId: 'filesystem.write',
        input: { path: 'out/linked-outside/escape.txt', content: 'blocked' },
      }],
      readPaths: ['.'],
      writePaths: ['out'],
      idempotencyKey: 'local-write-symlink-001',
    });
    assert.equal(result.status, 'FAILED');
    assert.match(result.summary, /symbolic|junction|escape/iu);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
    resetConfigForTests();
  }
});

test('same local executor idempotency key returns original result without a second write', async () => {
  const { root, service } = await fixture();
  try {
    const first = await service.executeLocalOperations({
      objective: 'Write once.',
      workspaceId: 'test',
      operations: [{
        toolId: 'filesystem.write',
        input: { path: 'out/idempotent.txt', content: 'first' },
      }],
      readPaths: ['.'],
      writePaths: ['out'],
      idempotencyKey: 'local-idempotency-001',
    });
    const second = await service.executeLocalOperations({
      objective: 'Attempt a duplicate call.',
      workspaceId: 'test',
      operations: [{
        toolId: 'filesystem.write',
        input: { path: 'out/idempotent.txt', content: 'second' },
      }],
      readPaths: ['.'],
      writePaths: ['out'],
      idempotencyKey: 'local-idempotency-001',
    });
    assert.deepEqual(second, first);
    assert.equal(await readFile(join(root, 'out', 'idempotent.txt'), 'utf8'), 'first');
  } finally {
    await rm(root, { recursive: true, force: true });
    resetConfigForTests();
  }
});

test('same idempotency key is isolated between inspection and mutation tools', async () => {
  const { root, service } = await fixture();
  try {
    const inspection = await service.inspectLocalRuntime({
      workspaceId: 'test',
      kind: 'system',
      idempotencyKey: 'shared-tool-key-001',
    });
    assert.equal(inspection.status, 'SUCCEEDED');
    assert.equal(inspection.result.kind, 'system');

    const mutation = await service.executeLocalOperations({
      objective: 'Write after an unrelated inspection using the same external key.',
      workspaceId: 'test',
      operations: [{
        toolId: 'filesystem.write',
        input: { path: 'out/namespaced.txt', content: 'namespaced-result' },
      }],
      readPaths: ['.'],
      writePaths: ['out'],
      idempotencyKey: 'shared-tool-key-001',
    });
    assert.equal(mutation.status, 'SUCCEEDED');
    assert.equal(mutation.target, 'LOCAL_EXECUTOR');
    assert.equal(await readFile(join(root, 'out', 'namespaced.txt'), 'utf8'), 'namespaced-result');
  } finally {
    await rm(root, { recursive: true, force: true });
    resetConfigForTests();
  }
});
