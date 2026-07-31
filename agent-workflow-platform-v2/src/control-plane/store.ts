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
  recordEvidence(input: EvidenceInput): Promise<void>;
  appendAudit(event: AuditEventInput): Promise<void>;
  healthCheck(): Promise<boolean>;
}
