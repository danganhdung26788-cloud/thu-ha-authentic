import { randomUUID } from 'node:crypto';
import { ChatStore } from '../../chat/chat-store.js';
import type { ManagerDecision } from '../../contracts/execution-context.js';
import type { PostgresControlPlaneStore } from '../../control-plane/postgres-store.js';
import type { TaskRecord } from '../../domain/task.js';
import { createTaskDiagnostic, type DiagnosticStage } from '../../diagnostics/task-diagnostic.js';
import type { ExecutorResult } from '../../executors/contracts.js';

const chat = new ChatStore();

export async function chatTaskClaimed(task: TaskRecord): Promise<void> {
  if (!task.conversationId) return;
  await chat.appendProgress({
    conversationId: task.conversationId,
    taskId: task.taskId,
    kind: 'STATUS',
    stage: 'RUNNING',
    message: 'Đang phân tích yêu cầu và kiểm tra phạm vi an toàn.',
    percent: 15,
    metadata: { attempt: task.attempt + 1 },
  });
}

export async function chatRouteAuthorized(
  task: TaskRecord,
  manager: ManagerDecision,
): Promise<void> {
  if (!task.conversationId) return;
  await chat.appendProgress({
    conversationId: task.conversationId,
    taskId: task.taskId,
    kind: 'ROUTE',
    stage: manager.executor,
    message: `Đã chọn tuyến ${manager.executor}. Đang chuẩn bị thực hiện.`,
    percent: 30,
    metadata: {
      executor: manager.executor,
      rationale: manager.rationale,
      requestedTools: manager.requestedTools,
    },
  });
}

export async function interruptForClarification(
  store: PostgresControlPlaneStore,
  task: TaskRecord,
  executionId: string,
  manager: ManagerDecision,
): Promise<boolean> {
  if (!manager.clarification) return false;
  const clarification = manager.clarification;
  if (!task.conversationId) {
    throw new Error('Manager requested clarification for a task without a conversation.');
  }
  const record = await chat.createClarification({
    conversationId: task.conversationId,
    taskId: task.taskId,
    question: clarification.question,
    options: clarification.options,
    reason: clarification.reason,
  });
  await store.finishExecution(executionId, 'INTERRUPTED', {
    manager,
    clarificationId: record.clarificationId,
  });
  await store.updateTaskStatus(task.taskId, 'WAITING_INPUT', {
    attempt: Math.max(1, task.attempt + 1),
    lastError: null,
  });
  await store.appendAudit({
    eventId: `AUD-${randomUUID()}`,
    taskId: task.taskId,
    executionId,
    correlationId: task.correlationId,
    ownerId: task.ownerId,
    workspaceId: task.workspaceId,
    eventType: 'CLARIFICATION_REQUESTED',
    actor: 'MANAGER_AGENT',
    details: {
      clarificationId: record.clarificationId,
      question: clarification.question,
      options: clarification.options,
      reason: clarification.reason,
    },
  });
  await chat.addAssistantMessage(
    task.conversationId,
    task.taskId,
    clarification.question,
    {
      type: 'CLARIFICATION',
      clarificationId: record.clarificationId,
      options: clarification.options,
      reason: clarification.reason,
    },
  );
  await chat.appendProgress({
    conversationId: task.conversationId,
    taskId: task.taskId,
    kind: 'CLARIFICATION',
    stage: 'WAITING_INPUT',
    message: 'Cần một câu trả lời nghiệp vụ trước khi tiếp tục.',
    percent: 35,
    metadata: { clarificationId: record.clarificationId },
  });
  await createTaskDiagnostic({
    task: { ...task, status: 'WAITING_INPUT', attempt: Math.max(1, task.attempt + 1) },
    stage: 'CLARIFICATION',
    error: clarification.reason,
    executor: manager.executor,
    routeSummary: manager.nextAction,
    context: { clarificationId: record.clarificationId, question: clarification.question },
  });
  return true;
}

export async function chatApprovalRequested(
  task: TaskRecord,
  approvalId: string,
  manager: ManagerDecision,
  reason: string,
): Promise<void> {
  if (!task.conversationId) return;
  await chat.addAssistantMessage(
    task.conversationId,
    task.taskId,
    `Tác vụ cần phê duyệt trước khi tiếp tục.\n\n${manager.nextAction}\n\nLý do: ${reason}`,
    { type: 'APPROVAL', approvalId, executor: manager.executor },
  );
  await chat.appendProgress({
    conversationId: task.conversationId,
    taskId: task.taskId,
    kind: 'APPROVAL',
    stage: 'WAITING_APPROVAL',
    message: 'Đang chờ phê duyệt cho thao tác được bảo vệ.',
    percent: 40,
    metadata: { approvalId, executor: manager.executor, reason },
  });
  await createTaskDiagnostic({
    task: { ...task, status: 'WAITING_APPROVAL', attempt: Math.max(1, task.attempt + 1) },
    stage: 'APPROVAL',
    error: reason,
    executor: manager.executor,
    routeSummary: manager.nextAction,
    context: { approvalId },
  });
}

export async function chatExecutionStarted(
  task: TaskRecord,
  manager: ManagerDecision,
): Promise<void> {
  if (!task.conversationId) return;
  await chat.appendProgress({
    conversationId: task.conversationId,
    taskId: task.taskId,
    kind: 'EXECUTION',
    stage: manager.executor,
    message: `${manager.executor} đang thực hiện nhiệm vụ.`,
    percent: 55,
    metadata: { executor: manager.executor, nextAction: manager.nextAction },
  });
}

export async function chatTaskCompleted(
  task: TaskRecord,
  manager: ManagerDecision,
  result: ExecutorResult,
): Promise<void> {
  if (!task.conversationId) return;
  await chat.addAssistantMessage(
    task.conversationId,
    task.taskId,
    result.summary,
    {
      type: 'RESULT',
      executor: manager.executor,
      output: result.output,
      evidenceCount: result.evidence.length,
    },
  );
  await chat.appendProgress({
    conversationId: task.conversationId,
    taskId: task.taskId,
    kind: 'RESULT',
    stage: 'COMPLETED',
    message: 'Nhiệm vụ đã hoàn thành.',
    percent: 100,
    metadata: { executor: manager.executor, summary: result.summary },
  });
}

export async function chatTaskRetryScheduled(
  task: TaskRecord,
  message: string,
  nextRunAt: Date,
): Promise<void> {
  if (!task.conversationId) return;
  await chat.appendProgress({
    conversationId: task.conversationId,
    taskId: task.taskId,
    kind: 'RECOVERY',
    stage: 'RETRY_WAIT',
    message: 'Hệ thống gặp lỗi tạm thời và đang tự lên lịch thử lại.',
    percent: 60,
    metadata: { error: message, nextRunAt: nextRunAt.toISOString() },
  });
}

export async function chatTaskFailed(
  task: TaskRecord,
  error: unknown,
  executor: string,
  stage: DiagnosticStage = 'EXECUTION',
): Promise<void> {
  if (!task.conversationId) return;
  const message = error instanceof Error ? error.message : String(error);
  await chat.addAssistantMessage(
    task.conversationId,
    task.taskId,
    'Không thể hoàn thành nhiệm vụ. Hệ thống đã tạo chẩn đoán an toàn để anh sao chép và hỏi ChatGPT.',
    { type: 'ERROR', executor, error: message },
    'FAILED',
  );
  await chat.appendProgress({
    conversationId: task.conversationId,
    taskId: task.taskId,
    kind: 'ERROR',
    stage: 'FAILED',
    message: 'Nhiệm vụ đã dừng an toàn. Có thể sao chép chẩn đoán để được hỗ trợ.',
    percent: 100,
    metadata: { executor, error: message },
  });
  await createTaskDiagnostic({
    task: { ...task, status: 'FAILED' },
    stage,
    error,
    executor,
  });
}
