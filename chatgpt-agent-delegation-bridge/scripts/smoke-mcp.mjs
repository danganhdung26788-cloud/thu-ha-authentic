import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const bind = process.env.MCP_BIND === 'localhost' ? '127.0.0.1' : (process.env.MCP_BIND || '127.0.0.1');
const port = process.env.MCP_PORT || '3210';
const path = process.env.MCP_PATH || '/mcp';
const url = new URL(process.env.MCP_URL || `http://${bind}:${port}${path}`);
const requestInit = process.env.MCP_AUTH_MODE === 'bearer' && process.env.MCP_AUTH_TOKEN
  ? { headers: { authorization: `Bearer ${process.env.MCP_AUTH_TOKEN}` } }
  : undefined;
const client = new Client({ name: 'system-ai-workflow-smoke', version: '1.0.0' });
const transport = new StreamableHTTPClientTransport(url, { requestInit });

try {
  await client.connect(transport);
  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name).sort();
  if (!names.includes('delegation_health')) throw new Error('delegation_health is missing.');
  const health = await client.callTool({ name: 'delegation_health', arguments: {} });
  if (health.isError) throw new Error('delegation_health returned an MCP error.');
  const structured = health.structuredContent || {};
  const architecture = structured.architecture || {};
  if (architecture.chatgptPrimaryBrain !== true) throw new Error('ChatGPT-primary invariant failed.');
  if (architecture.backendManagerAgent !== false) throw new Error('Backend Manager must remain disabled.');
  if (architecture.automaticBackendRouting !== false) throw new Error('Automatic backend routing must remain disabled.');
  if (architecture.v2RuntimeDependency !== false) throw new Error('V2 runtime dependency must remain disabled.');
  console.log(JSON.stringify({ ok: true, url: url.toString(), tools: names, architecture }, null, 2));
} finally {
  await client.close().catch(() => undefined);
}
