import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { HostAdapterEnvSchema } from '../src/host-adapter/config.js';
import { HermesHostExecutor } from '../src/host-adapter/hermes-executor.js';
import { extractToolCalls } from '../src/host-adapter/tool-calls.js';
import { pathInside, WorkspaceRegistry } from '../src/host-adapter/workspace-registry.js';
import { ExecutorRequestSchema } from '../src/executors/contracts.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'agent-v2-host-'));
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
  return { root, registryPath };
}

test('workspace scope rejects traversal', async () => {
  const { root, registryPath } = await fixture();
  try {
    const registry = await WorkspaceRegistry.load(registryPath);
    const entry = registry.get('owner-1', 'workspace-1');
    assert.equal(pathInside(join(root, 'a.txt'), root), true);
    assert.equal(pathInside(join(root, '..', 'outside.txt'), root), false);
    assert.throws(() => registry.resolveWritePath(entry, '../outside.txt'), /outside registered scope/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('tool calls survive the executor envelope marker', () => {
  const request = ExecutorRequestSchema.parse({
    context: {
      taskId: 'TASK-1',
      correlationId: 'CORR-1',
      ownerId: 'owner-1',
      workspaceId: 'workspace-1',
      readScope: ['.'],
      writeScope: ['.'],
      autonomyMode: 'SANDBOX_HIGH',
      riskLevel: 'LOW',
    },
    executor: 'HERMES',
    objective: 'Read a file',
    instructions: 'Read it.\n\n<workflow-v2-tool-calls>[{"toolId":"filesystem.read","input":{"path":"a.txt"}}]</workflow-v2-tool-calls>',
    requestedTools: ['filesystem.read'],
  });
  assert.deepEqual(extractToolCalls(request), [{ toolId: 'filesystem.read', input: { path: 'a.txt' } }]);
});

test('Hermes performs scoped file write and read with read-back', async () => {
  const { root, registryPath } = await fixture();
  try {
    const registry = await WorkspaceRegistry.load(registryPath);
    const env = HostAdapterEnvSchema.parse({
      HOST_ADAPTER_ROLE: 'HERMES',
      HOST_ADAPTER_PORT: '3201',
      HOST_ADAPTER_TOKEN: 'a'.repeat(32),
      HOST_ADAPTER_REGISTRY_PATH: registryPath,
      HOST_ADAPTER_RECEIPT_ROOT: join(root, 'receipts'),
    });
    const executor = new HermesHostExecutor(registry, env);
    const result = await executor.execute({
      context: {
        taskId: 'TASK-FILE-1',
        correlationId: 'CORR-FILE-1',
        ownerId: 'owner-1',
        workspaceId: 'workspace-1',
        readScope: [root],
        writeScope: [root],
        autonomyMode: 'SANDBOX_HIGH',
        riskLevel: 'LOW',
      },
      executor: 'HERMES',
      objective: 'Write and read a bounded test file.',
      instructions: 'Use the structured calls.',
      requestedTools: ['filesystem.write', 'filesystem.read'],
      toolCalls: [
        { toolId: 'filesystem.write', input: { path: 'data/test.txt', content: 'hello-v2' } },
        { toolId: 'filesystem.read', input: { path: 'data/test.txt' } },
      ],
    });
    assert.equal(result.status, 'SUCCEEDED');
    assert.equal(await readFile(join(root, 'data', 'test.txt'), 'utf8'), 'hello-v2');
    const actions = result.output.actions as Array<Record<string, unknown>>;
    assert.equal(actions.length, 2);
    assert.equal(actions[1]?.content, 'hello-v2');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
