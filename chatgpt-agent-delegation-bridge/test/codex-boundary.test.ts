import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { getConfig, resetConfigForTests } from '../src/config.js';
import { DelegationService } from '../src/delegation-service.js';
import { WorkspaceRegistry } from '../src/workspace-registry.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'delegation-codex-boundary-'));
  await mkdir(join(root, 'focus'), { recursive: true });
  resetConfigForTests();
  const config = getConfig({
    NODE_ENV: 'test',
    CODEX_ENABLED: 'true',
    LOCAL_EXECUTOR_ENABLED: 'false',
    SPECIALIST_AGENT_ENABLED: 'false',
  });
  const workspaces = WorkspaceRegistry.fromDocument({
    defaultWorkspaceId: 'test',
    workspaces: [{
      workspaceId: 'test',
      root,
      readRoots: ['.'],
      writeRoots: [],
      allowedExecutables: [],
      allowedScripts: [],
      scheduledTaskPrefix: 'TEST-',
      allowCodexRead: true,
      allowLocalRead: false,
      allowLocalWrite: false,
    }],
  });
  return { root, service: new DelegationService(config, workspaces) };
}

test('ask_codex rejects focus paths outside the registered workspace before SDK execution', async () => {
  const { root, service } = await fixture();
  try {
    await assert.rejects(
      service.askCodex({
        objective: 'Inspect a path outside the workspace.',
        workspaceId: 'test',
        paths: ['../outside'],
        idempotencyKey: 'codex-boundary-workspace-001',
      }),
      /outside the allowlisted workspace/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    resetConfigForTests();
  }
});

test('Codex input schema exposes proposal formats but no mutation mode', async () => {
  const { root, service } = await fixture();
  try {
    await assert.rejects(
      service.askCodex({
        objective: 'Reject an invalid response mode before SDK execution.',
        workspaceId: 'test',
        paths: ['focus'],
        responseFormat: 'workspace-write',
        idempotencyKey: 'codex-boundary-format-001',
      }),
      /Invalid option|responseFormat/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    resetConfigForTests();
  }
});

test('Codex health declares registered workspace root as the read boundary', async () => {
  const { root, service } = await fixture();
  try {
    const health = await service.health();
    const targets = health.targets as Record<string, unknown>;
    const codex = targets.codex as Record<string, unknown>;
    assert.equal(codex.mode, 'READ_ONLY_PROPOSAL');
    assert.equal(codex.readBoundary, 'REGISTERED_WORKSPACE_ROOT');
  } finally {
    await rm(root, { recursive: true, force: true });
    resetConfigForTests();
  }
});
