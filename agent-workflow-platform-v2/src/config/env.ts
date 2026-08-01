import { z } from 'zod';

function booleanString(defaultValue: 'true' | 'false') {
  return z
    .enum(['true', 'false'])
    .default(defaultValue)
    .transform((value) => value === 'true');
}

const OptionalUrlSchema = z.preprocess(
  (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
  z.string().url().optional(),
);

const OptionalSecretSchema = z.preprocess(
  (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
  z.string().min(8).optional(),
);

const OptionalStringSchema = z.preprocess(
  (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
  z.string().min(1).optional(),
);

export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3100),
  DATABASE_URL: z.string().min(1).default('postgresql://agent_v2:agent_v2@localhost:5432/agent_v2'),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
  QUEUE_NAME: z.string().min(1).default('agent-workflow-v2'),
  MINIO_ENDPOINT: z.string().min(1).default('localhost'),
  MINIO_PORT: z.coerce.number().int().min(1).max(65535).default(9000),
  MINIO_USE_SSL: booleanString('false'),
  MINIO_ACCESS_KEY: z.string().min(1).default('agent-v2'),
  MINIO_SECRET_KEY: z.string().min(8).default('agent-v2-local-secret'),
  MINIO_BUCKET: z.string().min(3).default('agent-v2-evidence'),

  MODEL_PROVIDER: z.enum(['ollama', 'openai']).default('ollama'),
  MODEL_BASE_URL: z.string().url().default('http://ollama:11434/v1'),
  MODEL_API_KEY: z.string().min(1).default('ollama-local'),
  MANAGER_MODEL: z.string().min(1).default('qwen3:4b'),
  SPECIALIST_MODEL: z.string().min(1).default('qwen3:4b'),
  MODEL_USE_RESPONSES: booleanString('false'),
  MODEL_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(300_000).default(90_000),
  OPENAI_API_KEY: OptionalStringSchema,
  OPENAI_MANAGER_MODEL: OptionalStringSchema,
  OPENAI_SPECIALIST_MODEL: OptionalStringSchema,
  OPENAI_AGENTS_DISABLE_TRACING: z.enum(['0', '1']).default('1'),
  AGENT_MAX_TURNS: z.coerce.number().int().min(1).max(100).default(12),

  DEFAULT_OWNER_ID: z.string().min(1).default('danganhdung'),
  DEFAULT_WORKSPACE_ID: z.string().min(1).default('workflow-v2-sandbox'),
  CHAT_SESSION_TTL_SECONDS: z.coerce.number().int().min(300).max(604_800).default(86_400),
  CHAT_ATTACHMENT_ROOT: z.string().min(1).default('/workspace/chat-attachments'),
  CHAT_ATTACHMENT_SCOPE_ROOT: z.string().min(1).default('runtime/chat-attachments'),
  CHAT_MAX_ATTACHMENT_BYTES: z.coerce.number().int().min(1_024).max(104_857_600).default(26_214_400),
  CHAT_MAX_DIAGNOSTIC_BYTES: z.coerce.number().int().min(4_096).max(131_072).default(20_480),
  CLAMAV_HOST: z.string().min(1).default('clamav'),
  CLAMAV_PORT: z.coerce.number().int().min(1).max(65_535).default(3_310),
  CLAMAV_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(300_000).default(120_000),
  CLAMAV_REQUIRED: booleanString('true'),
  RUNTIME_GIT_COMMIT: z.string().min(1).default('unknown'),

  GOOGLE_API_KEY: OptionalSecretSchema,
  GEMINI_MODEL: OptionalStringSchema,
  GEMINI_API_VERSION: z.enum(['v1', 'v1beta']).default('v1'),
  NOTEBOOKLM_SOURCE_PACKAGE_ONLY: booleanString('true'),
  CANVA_ADAPTER_URL: OptionalUrlSchema,
  CANVA_ACCESS_TOKEN: OptionalSecretSchema,
  API_AUTH_TOKEN: OptionalSecretSchema,
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
