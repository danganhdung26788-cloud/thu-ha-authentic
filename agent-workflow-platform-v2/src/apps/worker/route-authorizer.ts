import type { ExecutionContext, ManagerDecision } from '../../contracts/execution-context.js';
import {
  claimApprovedAction,
  type ApprovedActionLease,
} from '../../control-plane/approval-resume.js';
import type { TaskRecord } from '../../domain/task.js';
import {
  evaluateActionPolicy,
  type ActionRequest,
  type PolicyDecision,
} from '../../policy/policy-engine.js';
import { authorizeManagerTools, type RoutingAuthorization } from '../../registry/routing-authorization.js';
import { runManagerDecision } from '../../runtime/run-manager.js';

function booleanPayload(payload: Record<string, unknown>, key: string): boolean {
  return payload[key] === true;
}

export type AuthorizedRoute = Readonly<{
  manager: ManagerDecision;
  actionRequest: ActionRequest;
  policy: PolicyDecision;
  authorization: RoutingAuthorization;
  approvalLease: ApprovedActionLease | null;
}>;

export async function resolveAuthorizedRoute(
  task: TaskRecord,
  context: ExecutionContext,
  executionId: string,
): Promise<AuthorizedRoute> {
  const approvalLease = await claimApprovedAction(task.taskId, executionId);
  const manager = approvalLease?.action.manager
    ?? await runManagerDecision(context, task.objective);
  const authorization = await authorizeManagerTools(context, manager);

  if (approvalLease) {
    return {
      manager,
      authorization,
      approvalLease,
      actionRequest: {
        ...approvalLease.action.actionRequest,
        mutating: authorization.mutating,
        deepToolRequested: authorization.deepIntervention,
      },
      policy: {
        outcome: 'AUTO_APPROVE',
        reason: `Approval ${approvalLease.approvalId} resumed the stored action under lease.`,
      },
    };
  }

  const target = typeof task.payload.target === 'string'
    ? task.payload.target
    : undefined;
  const actionRequest: ActionRequest = {
    action: manager.nextAction,
    mutating: authorization.mutating,
    deepToolRequested: authorization.deepIntervention,
    ...(target ? { target } : {}),
    touchesProduction: booleanPayload(task.payload, 'touchesProduction'),
    changesCredentials: booleanPayload(task.payload, 'changesCredentials'),
    changesPermissions: booleanPayload(task.payload, 'changesPermissions'),
    rewritesHistory: booleanPayload(task.payload, 'rewritesHistory'),
    deepOperatingSystemChange: booleanPayload(task.payload, 'deepOperatingSystemChange'),
    destructive: booleanPayload(task.payload, 'destructive'),
    backupVerified: booleanPayload(task.payload, 'backupVerified'),
    estimatedCostUsd: typeof task.payload.estimatedCostUsd === 'number'
      ? task.payload.estimatedCostUsd
      : 0,
  };
  const policy = manager.requiresApproval
    ? { outcome: 'REQUIRE_APPROVAL' as const, reason: 'Manager identified deep intervention.' }
    : evaluateActionPolicy(context, actionRequest);

  return { manager, actionRequest, policy, authorization, approvalLease: null };
}
