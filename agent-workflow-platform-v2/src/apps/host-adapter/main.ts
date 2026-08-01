import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { getHostAdapterEnv, type HostAdapterEnv } from '../../host-adapter/config.js';
import { buildHostAdapterServer } from '../../host-adapter/server.js';

let app: Awaited<ReturnType<typeof buildHostAdapterServer>> | undefined;
let env: HostAdapterEnv | undefined;
let closing = false;

function startupErrorPath(): string {
  const receiptRoot = process.env.HOST_ADAPTER_RECEIPT_ROOT?.trim() || './runtime/receipts';
  const role = (process.env.HOST_ADAPTER_ROLE?.trim() || 'unknown').toLowerCase();
  return resolve(receiptRoot, '..', 'logs', `${role}.stderr.log`);
}

function safeErrorText(error: unknown): string {
  const text = error instanceof Error
    ? `${error.name}: ${error.message}\n${error.stack ?? ''}`
    : String(error);
  return text
    .replace(/(token|secret|password|credential|api[_-]?key)(\s*[:=]\s*)[^\s,;}]+/giu, '$1$2[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/giu, 'Bearer [REDACTED]')
    .slice(0, 20_000);
}

function persistStartupFailure(error: unknown): void {
  try {
    const path = startupErrorPath();
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(
      path,
      `[${new Date().toISOString()}] HOST_ADAPTER_STARTUP_FAILURE\n${safeErrorText(error)}\n\n`,
      'utf8',
    );
  } catch {
    // Do not mask the original startup failure.
  }
}

async function shutdown(signal: string, exitCode = 0): Promise<void> {
  if (closing) return;
  closing = true;
  app?.log.warn({ signal, exitCode, pid: process.pid, ppid: process.ppid }, 'Host adapter shutdown requested');
  try {
    if (app) await app.close();
  } finally {
    process.exitCode = exitCode;
  }
}

process.once('SIGINT', () => { void shutdown('SIGINT', 130); });
process.once('SIGTERM', () => { void shutdown('SIGTERM', 143); });
process.once('SIGHUP', () => { void shutdown('SIGHUP', 129); });
process.on('warning', (warning) => {
  app?.log.warn({ warning }, 'Host adapter process warning');
});
process.on('unhandledRejection', (reason) => {
  persistStartupFailure(reason);
  app?.log.fatal({ reason }, 'Host adapter unhandled rejection');
  void shutdown('UNHANDLED_REJECTION', 1);
});
process.on('uncaughtException', (error) => {
  persistStartupFailure(error);
  app?.log.fatal({ error }, 'Host adapter uncaught exception');
  void shutdown('UNCAUGHT_EXCEPTION', 1);
});
process.on('beforeExit', (code) => {
  app?.log.warn({ code, pid: process.pid }, 'Host adapter process beforeExit');
});

try {
  env = getHostAdapterEnv();
  app = await buildHostAdapterServer(env);
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
  persistStartupFailure(error);
  if (app) {
    app.log.fatal({ error, role: env?.HOST_ADAPTER_ROLE, pid: process.pid }, 'Host adapter startup failed');
  } else {
    console.error('Host adapter startup failed. See runtime/logs/<role>.stderr.log.');
  }
  await shutdown('STARTUP_FAILURE', 1);
}
