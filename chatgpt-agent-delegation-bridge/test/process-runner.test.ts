import assert from 'node:assert/strict';
import { basename } from 'node:path';
import test from 'node:test';
import { runProcess } from '../src/host/process-runner.js';

test('process runner accepts an absolute executable selected by the registry', async () => {
  const result = await runProcess({
    executable: process.execPath,
    args: ['--version'],
    cwd: process.cwd(),
    timeoutMs: 30_000,
    maxOutputBytes: 64_000,
  });
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /^v\d+/u);
});

test('process runner refuses to resolve a plain executable name through PATH', async () => {
  await assert.rejects(
    () => runProcess({
      executable: basename(process.execPath),
      args: ['--version'],
      cwd: process.cwd(),
      timeoutMs: 30_000,
      maxOutputBytes: 64_000,
    }),
    /absolute path resolved by the workspace allowlist/,
  );
});
