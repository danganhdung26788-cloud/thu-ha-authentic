import { z } from 'zod';

function optionalString() {
  return z.preprocess(
    (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
    z.string().min(1).optional(),
  );
}

function booleanString(defaultValue: 'true' | 'false') {
  return z.enum(['true', 'false']).default(defaultValue).transform((value) => value === 'true');
}

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  MCP_BIND: z.string().min(1).default('127.0.0.1'),
  MCP_PORT: z.coerce.number().int().min(1).max(65_535).default(3_210),
  MCP_PATH: z.string().regex(/^\/[A-Za-z0-9/_-]*$/).default('/mcp'),
  MCP_ALLOWED_HOSTS: z.string().default('127.0.0.1,localhost'),
  MCP_AUTH_MODE: z.enum(['none', 'bearer']).default('none'),
  MCP_AUTH_TOKEN: optionalString(),
  MAX_REQUEST_BYTES: z.coerce.number().int().min(16_384).max(10_485_760).default(1_048_576),
  MAX_OUTPUT_BYTES: z.coerce.number().int().min(16_384).max(10_485_760).default(1_048_576),
  DEFAULT_TIMEOUT_SECONDS: z.coerce.number().int().min(10).max(1_800).default(300),
  DELEGATION_OWNER_ID: z.string().min(1).max(120).default('danganhdung'),
  WORKSPACE_REGISTRY_PATH: z.string().min(1).default('./config/workspaces.json'),

  CODEX_ENABLED: booleanString('true'),
  CODEX_MODEL: optionalString(),
  CODEX_REASONING_EFFORT: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh']).default('high'),
  CODEX_NETWORK_ACCESS: booleanString('false'),

  HERMES_ENABLED: booleanString('false'),

  SPECIALIST_AGENT_ENABLED: booleanString('false'),
  SPECIALIST_MODEL: optionalString(),
  SPECIALIST_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
  SPECIALIST_API_KEY: optionalString(),
  SPECIALIST_USE_RESPONSES: booleanString('true'),
  SPECIALIST_MAX_TURNS: z.coerce.number().int().min(1).max(20).default(6),
});

export type BridgeConfig = Readonly<{
  nodeEnv: 'development' | 'test' | 'production';
  bind: string;
  port: number;
  mcpPath: string;
  allowedHosts: ReadonlySet<string>;
  authMode: 'none' | 'bearer';
  authToken?: string;
  maxRequestBytes: number;
  maxOutputBytes: number;
  defaultTimeoutSeconds: number;
  ownerId: string;
  workspaceRegistryPath: string;
  codex: Readonly<{
    enabled: boolean;
    model?: string;
    reasoningEffort: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
    networkAccess: boolean;
  }>;
  hermes: Readonly<{
    enabled: boolean;
  }>;
  specialist: Readonly<{
    enabled: boolean;
    model?: string;
    baseUrl: string;
    apiKey?: string;
    useResponses: boolean;
    maxTurns: number;
  }>;
}>;

let cached: BridgeConfig | undefined;

export function getConfig(source: NodeJS.ProcessEnv = process.env): BridgeConfig {
  if (cached) return cached;
  const env = EnvSchema.parse(source);
  const allowedHosts = new Set(
    env.MCP_ALLOWED_HOSTS.split(',').map((value) => value.trim().toLowerCase()).filter(Boolean),
  );
  if (!allowedHosts.size) throw new Error('MCP_ALLOWED_HOSTS must contain at least one host.');
  if (env.MCP_AUTH_MODE === 'bearer' && !env.MCP_AUTH_TOKEN) {
    throw new Error('MCP_AUTH_TOKEN is required when MCP_AUTH_MODE=bearer.');
  }
  if (env.NODE_ENV === 'production' && env.MCP_AUTH_MODE === 'none') {
    throw new Error('Production bridge must use authenticated MCP access.');
  }
  if (env.MCP_BIND !== '127.0.0.1' && env.MCP_BIND !== 'localhost' && env.MCP_AUTH_MODE === 'none') {
    throw new Error('Unauthenticated bridge may bind only to localhost.');
  }
  if (env.SPECIALIST_AGENT_ENABLED && (!env.SPECIALIST_MODEL || !env.SPECIALIST_API_KEY)) {
    throw new Error('Agents SDK specialist requires explicit SPECIALIST_MODEL and SPECIALIST_API_KEY.');
  }

  cached = {
    nodeEnv: env.NODE_ENV,
    bind: env.MCP_BIND,
    port: env.MCP_PORT,
    mcpPath: env.MCP_PATH,
    allowedHosts,
    authMode: env.MCP_AUTH_MODE,
    ...(env.MCP_AUTH_TOKEN ? { authToken: env.MCP_AUTH_TOKEN } : {}),
    maxRequestBytes: env.MAX_REQUEST_BYTES,
    maxOutputBytes: env.MAX_OUTPUT_BYTES,
    defaultTimeoutSeconds: env.DEFAULT_TIMEOUT_SECONDS,
    ownerId: env.DELEGATION_OWNER_ID,
    workspaceRegistryPath: env.WORKSPACE_REGISTRY_PATH,
    codex: {
      enabled: env.CODEX_ENABLED,
      ...(env.CODEX_MODEL ? { model: env.CODEX_MODEL } : {}),
      reasoningEffort: env.CODEX_REASONING_EFFORT,
      networkAccess: env.CODEX_NETWORK_ACCESS,
    },
    hermes: {
      enabled: env.HERMES_ENABLED,
    },
    specialist: {
      enabled: env.SPECIALIST_AGENT_ENABLED,
      ...(env.SPECIALIST_MODEL ? { model: env.SPECIALIST_MODEL } : {}),
      baseUrl: env.SPECIALIST_BASE_URL,
      ...(env.SPECIALIST_API_KEY ? { apiKey: env.SPECIALIST_API_KEY } : {}),
      useResponses: env.SPECIALIST_USE_RESPONSES,
      maxTurns: env.SPECIALIST_MAX_TURNS,
    },
  };
  return cached;
}

export function resetConfigForTests(): void {
  cached = undefined;
}
