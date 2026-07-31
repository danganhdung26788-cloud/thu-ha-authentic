import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { HostAdapterEnvSchema } from '../src/host-adapter/config.js';
import { buildHostAdapterServer } from '../src/host-adapter/server.js';

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'agent-v2-server-'));
  const registryPath = join(root, 'workspaces.json');
  await writeFile(registryPath, JSON.stringify({
    version: 1,
    workspaces: [{
      ownerId: 'owner-1',
      workspaceId: 'workspace-1',
      root,
      readRoots: [root],
      writeRoots: [root],
      allowedExecutables: [],
      allowedScripts: [],
      scheduledTaskPrefix: 'Hermes-V2-',
    }],
  }));
  const token = 't'.repeat(32);
  const env = HostAdapterEnvSchema.parse({
    HOST_ADAPTER_ROLE: 'HERMES',
    HOST_ADAPTER_PORT: '3201',
    HOST_ADAPTER_TOKEN: token,
    HOST_ADAPTER_REGISTRY_PATH: registryPath,
    HOST_ADAPTER_RECEIPT_ROOT: join(root, 'receipts'),
  });
  return { root, token, app: await buildHostAdapterServer(env) };
}

test('host adapter requires bearer authentication', async () => {
  const { root, app } = await setup();
  try {
    const response = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(response.statusCode, 401);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('host adapter returns the same receipt for repeated task id', async () => {
  const { root, token, app } = await setup();
  const body = {
    context: {
      taskId: 'TASK-IDEMPOTENT-1',
      correlationId: 'CORR-IDEMPOTENT-1',
      ownerId: 'owner-1',
      workspaceId: 'workspace-1',
      readScope: [root],
      writeScope: [root],
      autonomyMode: 'SANDBOX_HIGH',
      riskLevel: 'LOW',
    },
    executor: 'HERMES',
    objective: 'No-op bounded task.',
    instructions: 'No tools are required.',
    requestedTools: [],
    toolCalls: [],
  };
  const headers = {
    authorization: `Bearer ${token}`,
    'x-owner-id': 'owner-1',
    'x-workspace-id': 'workspace-1',
    'x-correlation-id': 'CORR-IDEMPOTENT-1',
    'x-idempotency-key': 'TASK-IDEMPOTENT-1',
  };
  try {
    const first = await app.inject({ method: 'POST', url: '/v1/execute', headers, payload: body });
    const second = await app.inject({ method: 'POST', url: '/v1/execute', headers, payload: body });
    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);
    assert.deepEqual(second.json(), first.json());
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
