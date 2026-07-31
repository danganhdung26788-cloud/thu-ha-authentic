import type { CreateTaskInput, TaskRecord, TaskStatus } from '../domain/task.js';
import type { ExecutionRecord, ExecutionStatus } from '../domain/execution.js';

export type AuditEventInput = Readonly<{
  eventId: string;
  taskId?: string;
  executionId?: string;
  correlationId: string;
  ownerId: string;
  workspaceId: string;
  eventType: string;
  actor: string;
  details?: Record<string, unknown>;
}>;

export type ApprovalInput = Readonly<{
  approvalId: string;
  taskId: string;
  ownerId: string;
  workspaceId: string;
  action: Record<string, unknown>;
}>;

export type ApprovalDecisionInput = Readonly<{
  approvalId: string;
  decision: 'APPROVED' | 'REJECTED';
  actor: string;
  reason?: string;
}>;

export type ApprovalDecisionResult = Readonly<{
  approvalId: string;
  taskId: string;
  ownerId: string;
  workspaceId: string;
  decision: 'APPROVED' | 'REJECTED';
}>;

export type ApprovedAction = Readonly<{
  approvalId: string;
  action: Record<string, unknown>;
}>;

export type EvidenceInput = Readonly<{
  evidenceId: string;
  taskId: string;
  executionId?: string;
  ownerId: string;
  workspaceId: string;
  objectKey: string;
  sha256: string;
  mediaType: string;
  sizeBytes: number;
}>;

export type OutboxEvent = Readonly<{
  outboxId: number;
  eventType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  attempts: number;
}>;

export interface ControlPlaneStore {
  createTask(input: CreateTaskInput): Promise<{ task: TaskRecord; created: boolean }>;
  getTask(taskId: string): Promise<TaskRecord | null>;
  updateTaskStatus(
    taskId: string,
    status: TaskStatus,
    options?: Readonly<{
      attempt?: number;
      nextRunAt?: Date | null;
      lastError?: string | null;
    }>,
  ): Promise<TaskRecord>;
  startExecution(record: ExecutionRecord): Promise<void>;
  finishExecution(
    executionId: string,
    status: Exclude<ExecutionStatus, 'STARTED'>,
    result?: Record<string, unknown> | null,
    error?: string | null,
  ): Promise<void>;
  createApproval(input: ApprovalInput): Promise<void>;
  decideApproval(input: ApprovalDecisionInput): Promise<ApprovalDecisionResult>;
  consumeApprovedAction(taskId: string): Promise<ApprovedAction | null>;
  recordEvidence(input: EvidenceInput): Promise<void>;
  appendAudit(event: AuditEventInput): Promise<void>;
  claimOutbox(limit?: number): Promise<OutboxEvent[]>;
  markOutboxPublished(outboxId: number): Promise<void>;
  listRecoverableTasks(staleBefore: Date, limit?: number): Promise<TaskRecord[]>;
  healthCheck(): Promise<boolean>;
}
