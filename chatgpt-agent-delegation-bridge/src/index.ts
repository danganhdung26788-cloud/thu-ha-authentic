import { getConfig } from './config.js';
import { DelegationService } from './delegation-service.js';
import { createHttpApp } from './mcp-server.js';
import { WorkspaceRegistry } from './workspace-registry.js';

const config = getConfig();
const workspaces = await WorkspaceRegistry.load(config.workspaceRegistryPath);
const service = new DelegationService(config, workspaces);
const app = createHttpApp(service, config);

const httpServer = app.listen(config.port, config.bind, () => {
  console.error([
    'ChatGPT delegation bridge started.',
    `Endpoint: http://${config.bind}:${config.port}${config.mcpPath}`,
    'Architecture: ChatGPT primary brain; no backend Manager; no separate chat/task platform.',
  ].join('\n'));
});

async function shutdown(signal: string): Promise<void> {
  console.error(`Delegation bridge shutdown: ${signal}`);
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.once('SIGINT', () => { void shutdown('SIGINT'); });
process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
