import { resolve } from 'node:path';
import { z } from 'zod';

const OptionalString = z.preprocess(
  (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
  z.string().min(1).optional(),
);

export const HostAdapterEnvSchema = z.object({
  HOST_ADAPTER_ROLE: z.enum(['HERMES', 'CODEX']),
  HOST_ADAPTER_PORT: z.coerce.number().int().min(1).max(65535),
  HOST_ADAPTER_TOKEN: z.string().min(24),
  HOST_ADAPTER_REGISTRY_PATH: z.string().min(1),
  HOST_ADAPTER_RECEIPT_ROOT: z.string().min(1).default('./runtime/receipts'),
  HOST_ADAPTER_MAX_OUTPUT_BYTES: z.coerce.number().int().min(1024).max(20_000_000).default(2_000_000),
  HOST_ADAPTER_DEFAULT_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(1_800_000).default(300_000),
  CODEX_MODEL: OptionalString,
  CODEX_REASONING_EFFORT: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh']).default('high'),
  CODEX_NETWORK_ACCESS: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
});

export type HostAdapterEnv = z.infer<typeof HostAdapterEnvSchema>;

export function getHostAdapterEnv(source: NodeJS.ProcessEnv = process.env): HostAdapterEnv {
  const parsed = HostAdapterEnvSchema.parse(source);
  return {
    ...parsed,
    HOST_ADAPTER_REGISTRY_PATH: resolve(parsed.HOST_ADAPTER_REGISTRY_PATH),
    HOST_ADAPTER_RECEIPT_ROOT: resolve(parsed.HOST_ADAPTER_RECEIPT_ROOT),
  };
}
