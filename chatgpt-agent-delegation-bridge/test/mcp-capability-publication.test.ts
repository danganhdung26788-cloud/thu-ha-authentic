import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { getConfig, resetConfigForTests } from '../src/config.js';
import { DelegationService } from '../src/delegation-service.js';
import { createHttpApp } from '../src/mcp-server.js';
import { WorkspaceRegistry } from '../src/workspace-registry.js';

async function listedTools(allowLocalWrite: boolean): Promise<string[]> {
  resetConfigForTests();
  const config = getConfig({
    NODE_ENV: 'test',
    MCP_BIND: '127.0.0.1',
    MCP_ALLOWED_HOSTS: '127.0.0.1,localhost',
    MCP_AUTH_MODE: 'none',
    CODEX_ENABLED: 'false',
    LOCAL_EXECUTOR_ENABLED: 'true',
    LOCAL_APPROVAL_TTL_SECONDS: '300',
    SPECIALIST_AGENT_ENABLED: 'false',
  });
  const workspaces = WorkspaceRegistry.fromDocument({
    defaultWorkspaceId: 'test-workspace',
    workspaces: [{
      workspaceId: 'test-workspace',
      root: process.cwd(),
      readRoots: ['.'],
      writeRoots: allowLocalWrite ? ['.'] : [],
      allowedExecutables: [],
      allowedScripts: [],
      scheduledTaskPrefix: 'TEST-',
      allowCodexRead: false,
      allowLocalRead: true,
      allowLocalWrite,
    }],
  });
  const service = new DelegationService(config, workspaces);
  const app = createHttpApp(service, config);
  const httpServer = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    httpServer.once('listening', resolve);
    httpServer.once('error', reject);
  });
  const address = httpServer.address() as AddressInfo;
  const client = new Client({ name: 'capability-publication-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${address.port}${config.mcpPath}`),
  );
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    return tools.tools.map((tool) => tool.name);
  } finally {
    await client.close().catch(() => undefined);
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => error ? reject(error) : resolve());
    });
    resetConfigForTests();
  }
}

test('read-only local policy publishes inspection but hides both write tools', async () => {
  const names = await listedTools(false);
  assert.ok(names.includes('delegation_health'));
  assert.ok(names.includes('inspect_local_runtime'));
  assert.equal(names.includes('prepare_local_operations'), false);
  assert.equal(names.includes('execute_local_operations'), false);
});

test('write policy publishes prepare and execute as a two-step pair', async () => {
  const names = await listedTools(true);
  assert.ok(names.includes('inspect_local_runtime'));
  assert.ok(names.includes('prepare_local_operations'));
  assert.ok(names.includes('execute_local_operations'));
});
