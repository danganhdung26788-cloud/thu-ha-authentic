import { getHostAdapterEnv } from '../../host-adapter/config.js';
import { buildHostAdapterServer } from '../../host-adapter/server.js';

const env = getHostAdapterEnv();
const app = await buildHostAdapterServer(env);
let closing = false;

async function shutdown(signal: string, exitCode = 0): Promise<void> {
  if (closing) return;
  closing = true;
  app.log.warn({ signal, exitCode, pid: process.pid, ppid: process.ppid }, 'Host adapter shutdown requested');
  try {
    await app.close();
  } finally {
    process.exitCode = exitCode;
  }
}

process.once('SIGINT', () => { void shutdown('SIGINT', 130); });
process.once('SIGTERM', () => { void shutdown('SIGTERM', 143); });
process.once('SIGHUP', () => { void shutdown('SIGHUP', 129); });
process.on('warning', (warning) => {
  app.log.warn({ warning }, 'Host adapter process warning');
});
process.on('unhandledRejection', (reason) => {
  app.log.fatal({ reason }, 'Host adapter unhandled rejection');
  void shutdown('UNHANDLED_REJECTION', 1);
});
process.on('uncaughtException', (error) => {
  app.log.fatal({ error }, 'Host adapter uncaught exception');
  void shutdown('UNCAUGHT_EXCEPTION', 1);
});
process.on('beforeExit', (code) => {
  app.log.warn({ code, pid: process.pid }, 'Host adapter process beforeExit');
});

try {
  await app.listen({
    host: env.HOST_ADAPTER_BIND,
    port: env.HOST_ADAPTER_PORT,
  });
  app.log.info({
    role: env.HOST_ADAPTER_ROLE,
    pid: process.pid,
    ppid: process.ppid,
    execPath: process.execPath,
    cwd: process.cwd(),
    argv: process.argv,
  }, 'Host adapter lifecycle started');
} catch (error) {
  app.log.fatal({ error, role: env.HOST_ADAPTER_ROLE, pid: process.pid }, 'Host adapter startup failed');
  await shutdown('STARTUP_FAILURE', 1);
}
