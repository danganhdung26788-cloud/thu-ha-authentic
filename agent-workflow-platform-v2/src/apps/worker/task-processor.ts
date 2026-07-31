import { randomUUID } from 'node:crypto';
import type { Job } from 'bullmq';
import { runSpecialistAgent } from '../../agents/specialist-agent.js';
import type { ExecutionContext } from '../../contracts/execution-context.js';
import {
  completeApprovedAction,
  releaseApprovedAction,
  type ApprovedActionLease,
} from '../../control-plane/approval-resume.js';
import { PostgresControlPlaneStore } from '../../control-plane/postgres-store.js';
import { MinioEvidenceStore } from '../../evidence/minio-evidence-store.js';
import type { ExecutorResult } from '../../executors/contracts.js';
import { createExecutorRegistry } from '../../executors/registry.js';
import { logger } from '../../observability/logger.js';
import { policyDecisions, taskDuration, taskTransitions } from '../../observability/metrics.js';
import {
  createTaskQueue,
  enqueueTask,
  type TaskJobData,
  type TaskJobResult,
} from '../../queue/task-queue.js';
import { resolveAuthorizedRoute } from './route-authorizer.js';

const TERMINAL = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function finalizeApprovalLease(
  store: PostgresControlPlaneStore,
  lease: ApprovedActionLease,
  context: ExecutionContext,
): Promise<void> {
  try {
    await completeApprovedAction(lease.approvalId, lease.executionId);
    await store.appendAudit({
      eventId: `AUD-${randomUUID()}`,
      taskId: context.taskId,
      executionId: lease.executionId,
      correlationId: context.correlationId,
      ownerId: context.ownerId,
      workspaceId: context.workspaceId,
      eventType: 'APPROVAL_EXECUTED',
      actor: 'ORCHESTRATOR_WORKER',
      details: { approvalId: lease.approvalId },
    });
  } catch (error) {
    logger.error(
      { err: error, approvalId: lease.approvalId, taskId: context.taskId },
      'Task completed but approval execution marker could not be finalized',
    );
    await store.appendAudit({
      eventId: `AUD-${randomUUID()}`,
      taskId: context.taskId,
      executionId: lease.executionId,
      correlationId: context.correlationId,
      ownerId: context.ownerId,
      workspaceId: context.workspaceId,
      eventType: 'APPROVAL_MARKER_FINALIZATION_FAILED',
      actor: 'ORCHESTRATOR_WORKER',
      details: {
        approvalId: lease.approvalId,
        error: errorMessage(error),
      },
    }).catch(() => undefined);
  }
}

export async function processTaskJob(job: Job<TaskJobData, TaskJobResult>): Promise<TaskJobResult> {
  const started = performance.now();
  const store = new PostgresControlPlaneStore();
  const evidenceStore = new MinioEvidenceStore();
  const queue = createTaskQueue();
  let executorLabel = 'UNROUTED';
  let approvalLease: ApprovedActionLease | null = null;
  const taskId = job.data.taskId;
  try {
    const task = await store.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (
      task.ownerId !== job.data.ownerId ||
      task.workspaceId !== job.data.workspaceId ||
      task.correlationId !== job.data.correlationId
    ) {
      throw new Error('Queue envelope does not match persisted owner/workspace/correlation contract.');
    }
    if (TERMINAL.has(task.status)) {
      return { taskId, status: task.status === 'COMPLETED' ? 'COMPLETED' : 'FAILED' };
    }
    if (task.status === 'WAITING_APPROVAL') return { taskId, status: 'WAITING_APPROVAL' };

    const attempt = task.status === 'RUNNING' ? Math.max(1, task.attempt) : task.attempt + 1;
    const executionId = `EXE-${taskId}-${attempt}`;
    taskTransitions.inc({ from: task.status, to: 'RUNNING' });
    await store.updateTaskStatus(taskId, 'RUNNING', { attempt, nextRunAt: null, lastError: null });
    await store.startExecution({
      executionId,
      taskId,
      ownerId: task.ownerId,
      workspaceId: task.workspaceId,
      executor: 'MANAGER',
      status: 'STARTED',
      attempt,
      startedAt: new Date(),
      finishedAt: null,
      result: null,
      error: null,
    });
    await store.appendAudit({
      eventId: `AUD-${randomUUID()}`,
      taskId,
      executionId,
      correlationId: task.correlationId,
      ownerId: task.ownerId,
      workspaceId: task.workspaceId,
      eventType: 'TASK_CLAIMED',
      actor: 'ORCHESTRATOR_WORKER',
      details: { attempt, bullJobId: job.id },
    });

    const context: ExecutionContext = {
      taskId,
      correlationId: task.correlationId,
      ownerId: task.ownerId,
      workspaceId: task.workspaceId,
      readScope: task.readScope,
      writeScope: task.writeScope,
      autonomyMode: task.autonomyMode,
      riskLevel: task.riskLevel,
    };

    const route = await resolveAuthorizedRoute(task, context, executionId);
    const { manager, actionRequest, policy, authorization } = route;
    approvalLease = route.approvalLease;
    executorLabel = manager.executor;
    policyDecisions.inc({ outcome: policy.outcome });

    await store.appendAudit({
      eventId: `AUD-${randomUUID()}`,
      taskId,
      executionId,
      correlationId: task.correlationId,
      ownerId: task.ownerId,
      workspaceId: task.workspaceId,
      eventType: 'ROUTE_AUTHORIZED',
      actor: 'TOOL_REGISTRY',
      details: {
        executor: manager.executor,
        agentId: authorization.agentId,
        tools: authorization.tools.map((tool) => ({
          toolId: tool.toolId,
          riskClass: tool.riskClass,
          adapter: tool.adapter,
        })),
        approvalResumed: approvalLease?.approvalId ?? null,
      },
    });

    if (approvalLease) {
      await store.appendAudit({
        eventId: `AUD-${randomUUID()}`,
        taskId,
        executionId,
        correlationId: task.correlationId,
        ownerId: task.ownerId,
        workspaceId: task.workspaceId,
        eventType: 'APPROVAL_RESUMED',
        actor: 'ORCHESTRATOR_WORKER',
        details: {
          approvalId: approvalLease.approvalId,
          originalPolicy: approvalLease.action.policy,
        },
      });
    }

    if (policy.outcome === 'DENY') {
      await store.finishExecution(executionId, 'FAILED', { manager, policy }, policy.reason);
      await store.updateTaskStatus(taskId, 'FAILED', { attempt, lastError: policy.reason });
      await store.appendAudit({
        eventId: `AUD-${randomUUID()}`,
        taskId,
        executionId,
        correlationId: task.correlationId,
        ownerId: task.ownerId,
        workspaceId: task.workspaceId,
        eventType: 'POLICY_DENIED',
        actor: 'POLICY_ENGINE',
        details: { manager, policy, actionRequest },
      });
      return { taskId, status: 'FAILED' };
    }

    if (policy.outcome === 'REQUIRE_APPROVAL') {
      const approvalId = `APR-${randomUUID()}`;
      await store.createApproval({
        approvalId,
        taskId,
        ownerId: task.ownerId,
        workspaceId: task.workspaceId,
        action: { manager, policy, actionRequest },
      });
      await store.finishExecution(executionId, 'INTERRUPTED', { manager, policy, approvalId });
      taskTransitions.inc({ from: 'RUNNING', to: 'WAITING_APPROVAL' });
      await store.updateTaskStatus(taskId, 'WAITING_APPROVAL', { attempt });
      await store.appendAudit({
        eventId: `AUD-${randomUUID()}`,
        taskId,
        executionId,
        correlationId: task.correlationId,
        ownerId: task.ownerId,
        workspaceId: task.workspaceId,
        eventType: 'APPROVAL_REQUESTED',
        actor: 'POLICY_ENGINE',
        details: { approvalId, manager, policy, actionRequest },
      });
      return { taskId, status: 'WAITING_APPROVAL' };
    }

    let result: ExecutorResult;
    if (manager.executor === 'SPECIALIST_AGENT' || manager.executor === 'CHATGPT') {
      const specialist = await runSpecialistAgent(context, task.objective, manager.nextAction);
      result = {
        status: 'SUCCEEDED',
        summary: specialist.summary,
        output: {
          ...specialist.result,
          warnings: specialist.warnings,
          confidence: specialist.confidence,
        },
        evidence: [],
        retryable: false,
      };
    } else {
      const adapter = createExecutorRegistry().get(manager.executor);
      result = await adapter.execute({
        context,
        executor: manager.executor,
        objective: task.objective,
        instructions: manager.nextAction,
        requestedTools: manager.requestedTools,
      });
    }

    for (const item of result.evidence) {
      const descriptor = await evidenceStore.put(
        task.ownerId,
        task.workspaceId,
        taskId,
        Buffer.from(item.contentBase64, 'base64'),
        item.mediaType,
        item.name,
      );
      await store.recordEvidence({
        ...descriptor,
        taskId,
        executionId,
        ownerId: task.ownerId,
        workspaceId: task.workspaceId,
      });
    }
    const resultEvidence = await evidenceStore.put(
      task.ownerId,
      task.workspaceId,
      taskId,
      Buffer.from(JSON.stringify({ manager, policy, result }, null, 2)),
      'application/json',
      'result.json',
    );
    await store.recordEvidence({
      ...resultEvidence,
      taskId,
      executionId,
      ownerId: task.ownerId,
      workspaceId: task.workspaceId,
    });

    if (result.status === 'SUCCEEDED') {
      await store.finishExecution(executionId, 'SUCCEEDED', {
        manager,
        policy,
        result,
        resultEvidence,
      });
      taskTransitions.inc({ from: 'RUNNING', to: 'COMPLETED' });
      await store.updateTaskStatus(taskId, 'COMPLETED', { attempt });
      await store.appendAudit({
        eventId: `AUD-${randomUUID()}`,
        taskId,
        executionId,
        correlationId: task.correlationId,
        ownerId: task.ownerId,
        workspaceId: task.workspaceId,
        eventType: 'TASK_COMPLETED',
        actor: manager.executor,
        details: { summary: result.summary, resultEvidence },
      });
      if (approvalLease) await finalizeApprovalLease(store, approvalLease, context);
      return { taskId, status: 'COMPLETED' };
    }

    throw Object.assign(new Error(result.summary), {
      retryable: result.retryable,
      result,
    });
  } catch (error) {
    if (approvalLease) {
      await releaseApprovedAction(approvalLease.approvalId, approvalLease.executionId)
        .catch((releaseError: unknown) => {
          logger.error(
            { err: releaseError, approvalId: approvalLease?.approvalId, taskId },
            'Failed to release approval resume lease',
          );
        });
    }
    const message = errorMessage(error);
    const task = await store.getTask(taskId).catch(() => null);
    if (!task) throw error;
    const attempt = Math.max(1, task.attempt);
    const executionId = `EXE-${taskId}-${attempt}`;
    const retryable = Boolean((error as { retryable?: unknown }).retryable)
      || error instanceof TypeError;
    const canRetry = retryable && attempt < task.maxAttempts;
    await store.finishExecution(executionId, 'FAILED', null, message).catch(() => undefined);
    if (canRetry) {
      const delay = Math.min(15 * 60_000, 30_000 * 2 ** (attempt - 1));
      const nextRunAt = new Date(Date.now() + delay);
      taskTransitions.inc({ from: 'RUNNING', to: 'RETRY_WAIT' });
      await store.updateTaskStatus(taskId, 'RETRY_WAIT', {
        attempt,
        nextRunAt,
        lastError: message,
      });
      await enqueueTask(queue, job.data, {
        delay,
        jobId: `${job.data.ownerId}:${job.data.workspaceId}:${taskId}:retry:${attempt + 1}`,
      });
      await store.appendAudit({
        eventId: `AUD-${randomUUID()}`,
        taskId,
        executionId,
        correlationId: task.correlationId,
        ownerId: task.ownerId,
        workspaceId: task.workspaceId,
        eventType: 'TASK_RETRY_SCHEDULED',
        actor: 'ORCHESTRATOR_WORKER',
        details: {
          attempt,
          nextRunAt: nextRunAt.toISOString(),
          error: message,
        },
      });
      return { taskId, status: 'RETRY_WAIT' };
    }
    taskTransitions.inc({ from: 'RUNNING', to: 'FAILED' });
    await store.updateTaskStatus(taskId, 'FAILED', { attempt, lastError: message });
    await store.appendAudit({
      eventId: `AUD-${randomUUID()}`,
      taskId,
      executionId,
      correlationId: task.correlationId,
      ownerId: task.ownerId,
      workspaceId: task.workspaceId,
      eventType: 'TASK_FAILED',
      actor: 'ORCHESTRATOR_WORKER',
      details: { attempt, error: message },
    });
    logger.error({ err: error, taskId, attempt }, 'Task failed');
    return { taskId, status: 'FAILED' };
  } finally {
    taskDuration.observe(
      { status: 'finished', executor: executorLabel },
      (performance.now() - started) / 1_000,
    );
    await queue.close();
  }
}
