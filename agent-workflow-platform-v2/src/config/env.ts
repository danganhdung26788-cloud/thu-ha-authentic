import { z } from 'zod';

const BooleanStringSchema = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const OptionalUrlSchema = z.preprocess(
  (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
  z.string().url().optional(),
);

const OptionalSecretSchema = z.preprocess(
  (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
  z.string().min(8).optional(),
);

export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3100),
  DATABASE_URL: z.string().min(1).default('postgresql://agent_v2:agent_v2@localhost:5432/agent_v2'),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
  QUEUE_NAME: z.string().min(1).default('agent-workflow-v2'),
  MINIO_ENDPOINT: z.string().min(1).default('localhost'),
  MINIO_PORT: z.coerce.number().int().min(1).max(65535).default(9000),
  MINIO_USE_SSL: BooleanStringSchema,
  MINIO_ACCESS_KEY: z.string().min(1).default('agent-v2'),
  MINIO_SECRET_KEY: z.string().min(8).default('agent-v2-local-secret'),
  MINIO_BUCKET: z.string().min(3).default('agent-v2-evidence'),
  OPENAI_API_KEY: z.string().optional(),
  HERMES_ADAPTER_URL: OptionalUrlSchema,
  CODEX_ADAPTER_URL: OptionalUrlSchema,
  CLAUDE_ADAPTER_URL: OptionalUrlSchema,
  ADAPTER_AUTH_TOKEN: OptionalSecretSchema,
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(2),
});

export type AppEnv = z.infer<typeof EnvSchema>;

let cachedEnv: AppEnv | undefined;

export function getEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  cachedEnv ??= EnvSchema.parse(source);
  return cachedEnv;
}

export function resetEnvForTests(): void {
  cachedEnv = undefined;
}
