import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { getConfig, resetConfigForTests } from '../src/config.js';
import { DelegationService } from '../src/delegation-service.js';
import { WorkspaceRegistry } from '../src/workspace-registry.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'delegation-hermes-'));
  await mkdir(join(root, 'out'), { recursive: true });
  resetConfigForTests();
  const config = getConfig({
    NODE_ENV: 'test',
    CODEX_ENABLED: 'false',
    HERMES_ENABLED: 'true',
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
      allowCodexWrite: false,
      allowHermesRead: true,
      allowHermesWrite: true,
    }],
  });
  return { root, service: new DelegationService(config, workspaces) };
}

test('direct Hermes writes only inside registered and request scopes with read-back', async () => {
  const { root, service } = await fixture();
  try {
    const result = await service.executeWithHermes({
      objective: 'Write one approved test file.',
      workspaceId: 'test',
      operations: [{
        toolId: 'filesystem.write',
        input: { path: 'out/result.txt', content: 'approved-content', encoding: 'utf8' },
      }],
      readPaths: ['.'],
      writePaths: ['out'],
      idempotencyKey: 'hermes-write-001',
    });
    assert.equal(result.status, 'SUCCEEDED');
    assert.equal(await readFile(join(root, 'out', 'result.txt'), 'utf8'), 'approved-content');
    const action = (result.result.actions as Array<Record<string, unknown>>)[0];
    assert.equal(action?.readBackVerified, true);
  } finally {
    await rm(root, { recursive: true, force: true });
    resetConfigForTests();
  }
});

test('direct Hermes rejects path escape and does not write outside workspace', async () => {
  const { root, service } = await fixture();
  try {
    const result = await service.executeWithHermes({
      objective: 'Attempt an invalid write.',
      workspaceId: 'test',
      operations: [{
        toolId: 'filesystem.write',
        input: { path: '../escape.txt', content: 'blocked' },
      }],
      readPaths: ['.'],
      writePaths: ['out'],
      idempotencyKey: 'hermes-write-escape-001',
    });
    assert.equal(result.status, 'FAILED');
    assert.match(result.summary, /outside|allowlisted|scope/iu);
  } finally {
    await rm(root, { recursive: true, force: true });
    resetConfigForTests();
  }
});

test('same Hermes idempotency key returns the original result without a second write', async () => {
  const { root, service } = await fixture();
  try {
    const first = await service.executeWithHermes({
      objective: 'Write once.',
      workspaceId: 'test',
      operations: [{
        toolId: 'filesystem.write',
        input: { path: 'out/idempotent.txt', content: 'first' },
      }],
      readPaths: ['.'],
      writePaths: ['out'],
      idempotencyKey: 'hermes-idempotency-001',
    });
    const second = await service.executeWithHermes({
      objective: 'Attempt a duplicate call.',
      workspaceId: 'test',
      operations: [{
        toolId: 'filesystem.write',
        input: { path: 'out/idempotent.txt', content: 'second' },
      }],
      readPaths: ['.'],
      writePaths: ['out'],
      idempotencyKey: 'hermes-idempotency-001',
    });
    assert.deepEqual(second, first);
    assert.equal(await readFile(join(root, 'out', 'idempotent.txt'), 'utf8'), 'first');
  } finally {
    await rm(root, { recursive: true, force: true });
    resetConfigForTests();
  }
});
