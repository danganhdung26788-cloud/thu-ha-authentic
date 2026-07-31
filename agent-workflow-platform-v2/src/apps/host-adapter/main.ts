import { getHostAdapterEnv } from '../../host-adapter/config.js';
import { buildHostAdapterServer } from '../../host-adapter/server.js';

const env = getHostAdapterEnv();
const app = await buildHostAdapterServer(env);

await app.listen({
  host: env.HOST_ADAPTER_BIND,
  port: env.HOST_ADAPTER_PORT,
});

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, 'Host adapter shutdown requested');
  await app.close();
}

process.once('SIGINT', () => { void shutdown('SIGINT'); });
process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
