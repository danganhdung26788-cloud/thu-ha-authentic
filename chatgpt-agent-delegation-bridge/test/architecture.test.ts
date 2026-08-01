import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  CodexDelegationInputSchema,
  LocalExecuteInputSchema,
} from '../src/contracts.js';
import { WorkspaceRegistry } from '../src/workspace-registry.js';

const ROOT = new URL('../', import.meta.url);

async function source(path: string): Promise<string> {
  return readFile(new URL(path, ROOT), 'utf8');
}

test('delegation inputs cannot select or override specialist target', () => {
  const codex = CodexDelegationInputSchema.parse({
    objective: 'Inspect the repository.',
    target: 'LOCAL_EXECUTOR',
  });
  assert.equal('target' in codex, false);

  const local = LocalExecuteInputSchema.parse({
    objective: 'Write an approved file.',
    operations: [{ toolId: 'filesystem.write', input: { path: 'a.txt', content: 'a' } }],
    readPaths: ['.'],
    writePaths: ['a.txt'],
    target: 'CODEX',
  });
  assert.equal('target' in local, false);
});

test('workspace registry rejects unregistered workspaces and path escape', () => {
  const registry = WorkspaceRegistry.fromDocument({
    defaultWorkspaceId: 'main',
    workspaces: [{
      workspaceId: 'main',
      root: process.cwd(),
      readRoots: ['.'],
      writeRoots: [],
      allowedExecutables: [],
      allowedScripts: [],
      scheduledTaskPrefix: 'TEST-',
      allowCodexRead: true,
      allowLocalRead: true,
      allowLocalWrite: false,
    }],
  });
  assert.equal(registry.get().workspaceId, 'main');
  assert.throws(() => registry.get('missing'), /not allowlisted/);
  assert.throws(() => registry.resolvePath(registry.get(), '../outside'), /outside/);
});

test('new bridge contains no replacement UI, business database, queue, or backend manager', async () => {
  const files = await Promise.all([
    source('src/index.ts'),
    source('src/mcp-server.ts'),
    source('src/delegation-service.ts'),
  ]);
  const combined = files.join('\n');
  assert.doesNotMatch(combined, /bullmq|ioredis|postgres|conversation_id|chat_messages|manager-agent|runManagerDecision/iu);
  assert.doesNotMatch(combined, /<html|textarea|chat-page|admin-page/iu);
  assert.match(combined, /ask_codex/);
  assert.doesNotMatch(combined, /execute_codex/);
  assert.match(combined, /ChatGPT remains responsible|ChatGPT primary brain/iu);
});

test('specialist AI tools are read-only while local mutation is separate and approval annotated', async () => {
  const mcp = await source('src/mcp-server.ts');
  assert.match(mcp, /'ask_codex'[\s\S]*?readOnlyHint:\s*true/);
  assert.doesNotMatch(mcp, /'execute_codex'/);
  assert.match(mcp, /'inspect_local_runtime'[\s\S]*?readOnlyHint:\s*true/);
  assert.match(mcp, /'execute_local_operations'[\s\S]*?destructiveHint:\s*true/);
  assert.match(mcp, /AI specialist tools are read-only/);
});

test('local executor is never presented as Hermes AI', async () => {
  const files = await Promise.all([
    source('src/contracts.ts'),
    source('src/config.ts'),
    source('src/delegation-service.ts'),
    source('src/mcp-server.ts'),
    source('src/specialists/local-executor.ts'),
  ]);
  const combined = files.join('\n');
  assert.doesNotMatch(combined, /HermesSpecialist|inspectWithHermes|executeWithHermes|HERMES_ENABLED/);
  assert.match(combined, /LOCAL_EXECUTOR/);
  assert.match(combined, /not an AI/iu);
});

test('Codex specialist is strictly read-only and proposal-oriented', async () => {
  const codex = await source('src/specialists/codex.ts');
  assert.match(codex, /sandboxMode:\s*'read-only'/);
  assert.match(codex, /READ_ONLY_PROPOSAL/);
  assert.match(codex, /unified diff as text/iu);
  assert.doesNotMatch(codex, /workspace-write/);
});
