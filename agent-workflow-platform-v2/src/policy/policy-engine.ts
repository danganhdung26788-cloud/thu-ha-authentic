import path from 'node:path';
import { z } from 'zod';
import type { ExecutionContext } from '../contracts/execution-context.js';

export const ActionRequestSchema = z.object({
  action: z.string().min(1),
  mutating: z.boolean().default(false),
  target: z.string().optional(),
  deepToolRequested: z.boolean().default(false),
  touchesProduction: z.boolean().default(false),
  changesCredentials: z.boolean().default(false),
  changesPermissions: z.boolean().default(false),
  rewritesHistory: z.boolean().default(false),
  deepOperatingSystemChange: z.boolean().default(false),
  destructive: z.boolean().default(false),
  backupVerified: z.boolean().default(false),
  estimatedCostUsd: z.number().nonnegative().default(0),
});

export type ActionRequest = z.input<typeof ActionRequestSchema>;

export type PolicyDecision = Readonly<{
  outcome: 'AUTO_APPROVE' | 'REQUIRE_APPROVAL' | 'DENY';
  reason: string;
}>;

type NormalizedResource = Readonly<{
  kind: 'WINDOWS_PATH' | 'POSIX_PATH' | 'URI' | 'OPAQUE';
  value: string;
  hierarchical: boolean;
}>;

function normalizeResource(rawValue: string): NormalizedResource {
  const value = rawValue.trim();
  if (/^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\')) {
    return {
      kind: 'WINDOWS_PATH',
      value: path.win32.resolve(value).replaceAll('\\', '/').toLowerCase(),
      hierarchical: true,
    };
  }
  if (value.startsWith('/')) {
    return {
      kind: 'POSIX_PATH',
      value: path.posix.resolve(value),
      hierarchical: true,
    };
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) {
    const url = new URL(value);
    if (url.username || url.password) throw new Error('Resource URI must not contain credentials.');
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(url.pathname);
    } catch {
      throw new Error('Resource URI contains invalid encoding.');
    }
    const normalizedPath = path.posix.resolve('/', decodedPath).replace(/\/$/, '');
    return {
      kind: 'URI',
      value: `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}${normalizedPath}`,
      hierarchical: true,
    };
  }
  return {
    kind: 'OPAQUE',
    value: value.toLowerCase(),
    hierarchical: false,
  };
}

function isWithinScope(targetValue: string, scopes: readonly string[]): boolean {
  const target = normalizeResource(targetValue);
  return scopes.some((scopeValue) => {
    const scope = normalizeResource(scopeValue);
    if (target.kind !== scope.kind) return false;
    if (target.value === scope.value) return true;
    if (!target.hierarchical || !scope.hierarchical) return false;
    return target.value.startsWith(`${scope.value.replace(/\/$/, '')}/`);
  });
}

export function evaluateActionPolicy(
  context: ExecutionContext,
  rawRequest: ActionRequest,
  deepInterventionCostUsd = 5,
): PolicyDecision {
  const request = ActionRequestSchema.parse(rawRequest);

  if (request.mutating && context.autonomyMode === 'READ_ONLY') {
    return { outcome: 'DENY', reason: 'READ_ONLY mode blocks mutations.' };
  }

  if (request.mutating && !request.target) {
    return {
      outcome: 'DENY',
      reason: 'Mutating actions require an explicit target inside WRITE_SCOPE.',
    };
  }

  if (request.target) {
    try {
      if (!isWithinScope(
        request.target,
        request.mutating ? context.writeScope : context.readScope,
      )) {
        return { outcome: 'DENY', reason: 'Target is outside the registered scope.' };
      }
    } catch {
      return { outcome: 'DENY', reason: 'Target or scope is invalid.' };
    }
  }

  const deepIntervention =
    request.deepToolRequested ||
    request.touchesProduction ||
    request.changesCredentials ||
    request.changesPermissions ||
    request.rewritesHistory ||
    request.deepOperatingSystemChange ||
    (request.destructive && !request.backupVerified) ||
    request.estimatedCostUsd >= deepInterventionCostUsd ||
    context.riskLevel === 'CRITICAL';

  if (deepIntervention) {
    return {
      outcome: 'REQUIRE_APPROVAL',
      reason: 'Action meets the DEEP_INTERVENTION_REQUIRED policy.',
    };
  }

  if (context.autonomyMode === 'PRODUCTION_GUARDED' && request.mutating) {
    return {
      outcome: 'REQUIRE_APPROVAL',
      reason: 'Production guarded mode requires approval for mutations.',
    };
  }

  return {
    outcome: 'AUTO_APPROVE',
    reason: 'Action is inside scope and below the deep-intervention threshold.',
  };
}
