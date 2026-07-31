import { z } from 'zod';
import type { ExecutionContext } from '../contracts/execution-context.js';

export const ActionRequestSchema = z.object({
  action: z.string().min(1),
  mutating: z.boolean().default(false),
  target: z.string().optional(),
  touchesProduction: z.boolean().default(false),
  changesCredentials: z.boolean().default(false),
  changesPermissions: z.boolean().default(false),
  rewritesHistory: z.boolean().default(false),
  deepOperatingSystemChange: z.boolean().default(false),
  destructive: z.boolean().default(false),
  backupVerified: z.boolean().default(false),
  estimatedCostUsd: z.number().nonnegative().default(0),
});

export type ActionRequest = z.infer<typeof ActionRequestSchema>;

export type PolicyDecision = Readonly<{
  outcome: 'AUTO_APPROVE' | 'REQUIRE_APPROVAL' | 'DENY';
  reason: string;
}>;

function isWithinScope(target: string, scopes: readonly string[]): boolean {
  const normalizedTarget = target.replaceAll('\\', '/').toLowerCase();
  return scopes.some((scope) => {
    const normalizedScope = scope.replaceAll('\\', '/').toLowerCase();
    return (
      normalizedTarget === normalizedScope ||
      normalizedTarget.startsWith(`${normalizedScope.replace(/\/$/, '')}/`)
    );
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

  if (
    request.target &&
    !isWithinScope(
      request.target,
      request.mutating ? context.writeScope : context.readScope,
    )
  ) {
    return { outcome: 'DENY', reason: 'Target is outside the registered scope.' };
  }

  const deepIntervention =
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
