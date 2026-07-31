import { timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import { ExecutorRequestSchema, ExecutorResultSchema, type ExecutorResult } from '../executors/contracts.js';
import type { HostAdapterEnv } from './config.js';
import { CodexHostExecutor } from './codex-executor.js';
import { HermesHostExecutor } from './hermes-executor.js';
import { ReceiptStore } from './receipts.js';
import { WorkspaceRegistry } from './workspace-registry.js';

function tokenMatches(header: string | undefined, expected: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const actual = Buffer.from(header.slice('Bearer '.length));
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

function assertHeaderContract(
  headers: Record<string, string | string[] | undefined>,
  body: ReturnType<typeof ExecutorRequestSchema.parse>,
): void {
  const values: Array<[string, string | undefined, string]> = [
    ['x-owner-id', headers['x-owner-id'] as string | undefined, body.context.ownerId],
    ['x-workspace-id', headers['x-workspace-id'] as string | undefined, body.context.workspaceId],
    ['x-correlation-id', headers['x-correlation-id'] as string | undefined, body.context.correlationId],
    ['x-idempotency-key', headers['x-idempotency-key'] as string | undefined, body.context.taskId],
  ];
  for (const [name, actual, expected] of values) {
    if (actual !== expected) throw new Error(`Header contract mismatch: ${name}`);
  }
}

export async function buildHostAdapterServer(env: HostAdapterEnv) {
  const registry = await WorkspaceRegistry.load(env.HOST_ADAPTER_REGISTRY_PATH);
  const executor = env.HOST_ADAPTER_ROLE === 'HERMES'
    ? new HermesHostExecutor(registry, env)
    : new CodexHostExecutor(registry, env);
  const receipts = new ReceiptStore(env.HOST_ADAPTER_RECEIPT_ROOT, env.HOST_ADAPTER_ROLE);
  const inFlight = new Map<string, Promise<ExecutorResult>>();
  const app = Fastify({
    logger: true,
    bodyLimit: 10 * 1024 * 1024,
    requestTimeout: env.HOST_ADAPTER_DEFAULT_TIMEOUT_MS + 30_000,
  });

  app.addHook('onRequest', async (request, reply) => {
    if (!tokenMatches(request.headers.authorization, env.HOST_ADAPTER_TOKEN)) {
      await reply.code(401).send({ error: 'unauthorized' });
    }
  });

  app.get('/health', async () => ({
    ok: true,
    role: env.HOST_ADAPTER_ROLE,
    platform: process.platform,
    node: process.version,
  }));

  app.get('/ready', async () => ({
    ready: true,
    role: env.HOST_ADAPTER_ROLE,
    registryPath: env.HOST_ADAPTER_REGISTRY_PATH,
  }));

  app.post('/v1/execute', async (request, reply) => {
    try {
      const body = ExecutorRequestSchema.parse(request.body);
      assertHeaderContract(request.headers, body);
      if (body.executor !== env.HOST_ADAPTER_ROLE) {
        return reply.code(400).send({ error: `adapter role mismatch: ${body.executor}` });
      }
      const key = `${body.context.ownerId}\u0000${body.context.workspaceId}\u0000${body.context.taskId}`;
      const prior = await receipts.read(body.context.ownerId, body.context.workspaceId, body.context.taskId);
      if (prior) return reply.send(prior);

      let execution = inFlight.get(key);
      if (!execution) {
        execution = executor.execute(body)
          .then((result) => ExecutorResultSchema.parse(result))
          .then(async (result) => {
            await receipts.write(body.context.ownerId, body.context.workspaceId, body.context.taskId, result);
            return result;
          })
          .finally(() => inFlight.delete(key));
        inFlight.set(key, execution);
      }
      return reply.send(await execution);
    } catch (error) {
      request.log.error({ err: error }, 'Host adapter execution failed');
      return reply.code(400).send({
        status: 'FAILED',
        summary: error instanceof Error ? error.message : String(error),
        output: {},
        evidence: [],
        errorCode: 'HOST_ADAPTER_REQUEST_REJECTED',
        retryable: false,
      });
    }
  });

  return app;
}
