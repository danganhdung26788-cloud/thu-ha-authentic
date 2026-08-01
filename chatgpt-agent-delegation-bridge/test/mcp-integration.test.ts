import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { getConfig, resetConfigForTests } from '../src/config.js';
import { DelegationService } from '../src/delegation-service.js';
import { createHttpApp } from '../src/mcp-server.js';
import { WorkspaceRegistry } from '../src/workspace-registry.js';

test('official MCP client lists explicit tools and calls delegation_health', async () => {
  resetConfigForTests();
  const config = getConfig({
    NODE_ENV: 'test',
    MCP_BIND: '127.0.0.1',
    MCP_ALLOWED_HOSTS: '127.0.0.1,localhost',
    MCP_AUTH_MODE: 'none',
    CODEX_ENABLED: 'true',
    HERMES_ENABLED: 'false',
    SPECIALIST_AGENT_ENABLED: 'false',
  });
  const workspaces = WorkspaceRegistry.fromDocument({
    defaultWorkspaceId: 'test-workspace',
    workspaces: [{
      workspaceId: 'test-workspace',
      root: process.cwd(),
      allowCodexRead: true,
      allowCodexWrite: false,
      allowHermesRead: false,
      allowHermesWrite: false,
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
  const client = new Client({ name: 'bridge-integration-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${address.port}${config.mcpPath}`),
  );
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);
    assert.ok(names.includes('delegation_health'));
    assert.ok(names.includes('ask_codex'));
    assert.ok(names.includes('execute_codex'));
    assert.equal(names.includes('inspect_with_hermes'), false);
    assert.equal(names.includes('ask_specialist_agent'), false);

    const result = await client.callTool({ name: 'delegation_health', arguments: {} });
    assert.equal(result.isError, undefined);
    const structured = result.structuredContent as Record<string, unknown>;
    const architecture = structured.architecture as Record<string, unknown>;
    assert.equal(architecture.chatgptPrimaryBrain, true);
    assert.equal(architecture.backendManagerAgent, false);
    assert.equal(architecture.automaticBackendRouting, false);
  } finally {
    await client.close().catch(() => undefined);
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => error ? reject(error) : resolve());
    });
    resetConfigForTests();
  }
});
