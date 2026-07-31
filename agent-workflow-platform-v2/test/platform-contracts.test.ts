import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { getEnv, resetEnvForTests } from '../src/config/env.js';
import { CreateTaskSchema } from '../src/domain/task.js';
import { DockerSandbox } from '../src/sandbox/docker-sandbox.js';

test('empty optional adapter URLs are normalized to undefined', () => {
  resetEnvForTests();
  const env = getEnv({
    HERMES_ADAPTER_URL: '',
    CODEX_ADAPTER_URL: '   ',
    CLAUDE_ADAPTER_URL: '',
  });
  assert.equal(env.HERMES_ADAPTER_URL, undefined);
  assert.equal(env.CODEX_ADAPTER_URL, undefined);
  assert.equal(env.CLAUDE_ADAPTER_URL, undefined);
  resetEnvForTests();
});

test('task contract applies bounded retry and payload defaults', () => {
  const task = CreateTaskSchema.parse({
    taskId: 'TASK-1',
    correlationId: 'CORR-1',
    idempotencyKey: 'idem-1',
    ownerId: 'owner',
    workspaceId: 'workspace',
    objective: 'Run the bounded task',
    readScope: ['/workspace'],
    writeScope: [],
    autonomyMode: 'SANDBOX_HIGH',
    riskLevel: 'LOW',
  });
  assert.equal(task.maxAttempts, 3);
  assert.deepEqual(task.payload, {});
});

test('sandbox rejects a workspace outside the allowlist before spawning Docker', async () => {
  const sandbox = new DockerSandbox();
  await assert.rejects(
    sandbox.execute({
      image: 'node:22-bookworm-slim',
      workspacePath: path.resolve('/outside'),
      allowedRoots: [path.resolve('/allowed')],
      command: ['node', '--version'],
    }),
    /outside the registered path allowlist/,
  );
});

test('sandbox rejects a non-allowlisted executable before spawning Docker', async () => {
  const sandbox = new DockerSandbox();
  const root = path.resolve('/workspace');
  await assert.rejects(
    sandbox.execute({
      image: 'node:22-bookworm-slim',
      workspacePath: root,
      allowedRoots: [root],
      command: ['bash', '-c', 'echo unsafe'],
    }),
    /Executable is not allowlisted/,
  );
});
