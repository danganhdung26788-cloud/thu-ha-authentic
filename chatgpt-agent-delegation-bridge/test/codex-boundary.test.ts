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
  await mkdir(join(root, 'allowed'), { recursive: true });
  await mkdir(join(root, 'private'), { recursive: true });
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
      readRoots: ['allowed'],
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

test('ask_codex rejects a path inside the workspace but outside registered read roots', async () => {
  const { root, service } = await fixture();
  try {
    await assert.rejects(
      service.askCodex({
        objective: 'Inspect a private path that was not granted.',
        workspaceId: 'test',
        paths: ['private'],
        responseFormat: 'implementation-plan',
        idempotencyKey: 'codex-boundary-read-root-001',
      }),
      /outside registered read roots/,
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
        paths: ['allowed'],
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
