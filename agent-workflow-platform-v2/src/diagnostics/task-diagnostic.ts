import { getEnv } from '../config/env.js';
import { PostgresControlPlaneStore } from '../control-plane/postgres-store.js';
import { getPool } from '../db/pool.js';
import type { TaskRecord } from '../domain/task.js';
import { MinioEvidenceStore } from '../evidence/minio-evidence-store.js';
import { createExecutorRegistry } from '../executors/registry.js';
import { modelProviderHealthCheck } from '../models/model-provider.js';
import { createTaskQueue } from '../queue/task-queue.js';
import { ChatStore } from '../chat/chat-store.js';
import { redactSecrets } from './redaction.js';

export type DiagnosticStage =
  | 'ROUTING'
  | 'CLARIFICATION'
  | 'APPROVAL'
  | 'EXECUTION'
  | 'RECOVERY'
  | 'STARTUP';

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function normalizeDiagnosticCode(error: unknown, stage: DiagnosticStage): string {
  const message = errorText(error).toLowerCase();
  if (stage === 'CLARIFICATION') return 'CLARIFICATION_REQUIRED';
  if (stage === 'APPROVAL') return 'APPROVAL_REQUIRED';
  if (message.includes('model') || message.includes('ollama') || message.includes('chat completions')) {
    return 'MODEL_PROVIDER_UNAVAILABLE';
  }
  if (message.includes('adapter') || message.includes('econnrefused') || message.includes('fetch failed')) {
    return 'ADAPTER_UNREACHABLE';
  }
  if (message.includes('policy') || message.includes('denied') || message.includes('not allowed')) {
    return 'POLICY_BLOCKED';
  }
  if (message.includes('timeout') || message.includes('aborted')) return 'OPERATION_TIMEOUT';
  if (message.includes('database') || message.includes('postgres')) return 'DATABASE_ERROR';
  if (message.includes('redis') || message.includes('queue')) return 'QUEUE_ERROR';
  if (message.includes('minio') || message.includes('evidence')) return 'EVIDENCE_STORE_ERROR';
  return 'UNEXPECTED_RUNTIME_ERROR';
}

async function recentAudit(taskId: string): Promise<string[]> {
  const result = await getPool().query<{
    event_type: string;
    actor: string;
    details: Record<string, unknown>;
    created_at: Date;
  }>(
    `SELECT event_type, actor, details, created_at FROM audit_events
     WHERE task_id = $1 ORDER BY sequence_id DESC LIMIT 20`,
    [taskId],
  );
  return result.rows.reverse().map((row) => (
    `[${row.created_at.toISOString()}] ${row.event_type} actor=${row.actor} details=${JSON.stringify(row.details)}`
  ));
}

async function collectHealth(): Promise<Record<string, unknown>> {
  const store = new PostgresControlPlaneStore();
  const evidence = new MinioEvidenceStore();
  const queue = createTaskQueue();
  try {
    const adapterEntries = createExecutorRegistry().entries();
    const adapterPairs = await Promise.all(adapterEntries.map(async ([name, adapter]) => (
      [name, await adapter.healthCheck().catch(() => false)] as const
    )));
    const model = await modelProviderHealthCheck();
    return {
      api: true,
      database: await store.healthCheck().catch(() => false),
      redis: await queue.getJobCounts().then(() => true).catch(() => false),
      evidence: await evidence.healthCheck().catch(() => false),
      model: {
        ok: model.ok,
        provider: model.provider,
        managerModel: model.managerModel,
        modelAvailable: model.modelAvailable,
        latencyMs: model.latencyMs,
        error: model.error ?? null,
      },
      adapters: Object.fromEntries(adapterPairs),
    };
  } finally {
    await queue.close().catch(() => undefined);
  }
}

export async function createTaskDiagnostic(input: Readonly<{
  task: TaskRecord;
  stage: DiagnosticStage;
  error: unknown;
  executor?: string;
  routeSummary?: string;
  context?: Record<string, unknown>;
}>): Promise<void> {
  if (!input.task.conversationId) return;
  const env = getEnv();
  const code = normalizeDiagnosticCode(input.error, input.stage);
  const summary = input.stage === 'APPROVAL'
    ? 'Nhiệm vụ đang chờ phê duyệt trước khi tiếp tục.'
    : input.stage === 'CLARIFICATION'
      ? 'Nhiệm vụ cần một câu trả lời nghiệp vụ trước khi tiếp tục.'
      : `Không thể hoàn thành nhiệm vụ tại bước ${input.stage.toLowerCase()}.`;
  const health = await collectHealth().catch((healthError: unknown) => ({
    collectionError: errorText(healthError),
  }));
  const audit = await recentAudit(input.task.taskId).catch((auditError: unknown) => [
    `Không đọc được audit: ${errorText(auditError)}`,
  ]);
  const raw = [
    'WORKFLOW AI V2 — DIAGNOSTIC REPORT',
    '',
    `Thời gian: ${new Date().toISOString()}`,
    `Runtime commit: ${env.RUNTIME_GIT_COMMIT}`,
    `Cutover phase: V1_ONLY`,
    `Task ID: ${input.task.taskId}`,
    `Correlation ID: ${input.task.correlationId}`,
    `Conversation ID: ${input.task.conversationId}`,
    `Trạng thái: ${input.task.status}`,
    `Bước: ${input.stage}`,
    `Executor: ${input.executor ?? 'CHƯA_XÁC_ĐỊNH'}`,
    `Mã chẩn đoán: ${code}`,
    '',
    'Mục tiêu:',
    input.task.objective,
    '',
    'Tóm tắt:',
    summary,
    '',
    'Lỗi hoặc lý do:',
    errorText(input.error),
    '',
    'Tuyến xử lý:',
    input.routeSummary ?? 'Chưa có hoặc không đọc được tuyến xử lý.',
    '',
    'Trạng thái thành phần:',
    JSON.stringify(health, null, 2),
    '',
    `Số lần chạy: ${input.task.attempt}/${input.task.maxAttempts}`,
    `Lần cập nhật cuối: ${input.task.updatedAt.toISOString()}`,
    '',
    'Audit gần nhất:',
    ...audit,
    '',
    'Bối cảnh bổ sung:',
    JSON.stringify(input.context ?? {}, null, 2),
    '',
    'Bí mật đã được tự động che trước khi sao chép.',
    '',
    'Yêu cầu hỗ trợ:',
    'Hãy phân tích nguyên nhân, phản biện các giả định và đề xuất bước xử lý an toàn. Không yêu cầu tôi cung cấp API key, token hoặc mật khẩu.',
  ].join('\n');
  const redacted = redactSecrets(raw, env.CHAT_MAX_DIAGNOSTIC_BYTES);
  const chat = new ChatStore();
  await chat.createDiagnostic({
    conversationId: input.task.conversationId,
    taskId: input.task.taskId,
    errorCode: code,
    summary,
    reportText: redacted.text,
    redactionCount: redacted.redactionCount,
    metadata: {
      stage: input.stage,
      executor: input.executor ?? null,
      runtimeCommit: env.RUNTIME_GIT_COMMIT,
    },
  });
}
