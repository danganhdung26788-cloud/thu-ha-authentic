import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const ROOT = new URL('../', import.meta.url);

async function source(path: string): Promise<string> {
  return readFile(new URL(path, ROOT), 'utf8');
}

test('Windows read-only installer migrates non-secret capability settings safely', async () => {
  const script = await source('scripts/windows/Install-BridgeReadOnly.ps1');
  assert.match(script, /LOCAL_EXECUTOR_ENABLED'\s+-Value\s+'true/);
  assert.match(script, /CODEX_NETWORK_ACCESS'\s+-Value\s+'false/);
  assert.match(script, /SPECIALIST_AGENT_ENABLED'\s+-Value\s+'false/);
  assert.match(script, /Read-only UAT refuses workspace write permission/);
  assert.match(script, /Read-only UAT refuses configured write roots/);
  assert.match(script, /Read-only UAT refuses configured executable scripts/);
  assert.match(script, /LOCAL_INSPECTION_ENABLED=true/);
  assert.match(script, /LOCAL_WRITE_ENABLED=false/);
});

test('MCP smoke requires inspection and rejects mutation in the default profile', async () => {
  const script = await source('scripts/smoke-mcp.mjs');
  assert.match(script, /inspect_local_runtime is missing from the default read-only profile/);
  assert.match(script, /Local mutation tool must not be exposed while workspace write policy is disabled/);
});
