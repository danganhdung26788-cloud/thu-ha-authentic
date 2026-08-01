import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { CreateTaskSchema, TaskRecordSchema, type CreateTaskInput, type TaskRecord, type TaskStatus } from '../domain/task.js';
import type { ExecutionRecord, ExecutionStatus } from '../domain/execution.js';
import { getPool, withTransaction } from '../db/pool.js';
import type {
  ApprovalDecisionInput,
  ApprovalDecisionResult,
  ApprovalInput,
  AuditEventInput,
  ControlPlaneStore,
  EvidenceInput,
  OutboxEvent,
} from './store.js';

type TaskRow = Readonly<{
  task_id: string;
  correlation_id: string;
  idempotency_key: string;
  owner_id: string;
  workspace_id: string;
  conversation_id: string | null;
  source_message_id: string | null;
  objective: string;
  read_scope: unknown;
  write_scope: unknown;
  autonomy_mode: string;
  risk_level: string;
  payload: unknown;
  status: string;
  attempt: number;
  max_attempts: number;
  next_run_at: Date | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}>;

type OutboxRow = Readonly<{
  outbox_id: number;
  event_type: string;
  aggregate_id: string;
  payload: Record<string, unknown>;
  attempts: number;
}>;

function mapTask(row: TaskRow): TaskRecord {
  return TaskRecordSchema.parse({
    taskId: row.task_id,
    correlationId: row.correlation_id,
    idempotencyKey: row.idempotency_key,
    ownerId: row.owner_id,
    workspaceId: row.workspace_id,
    conversationId: row.conversation_id,
    sourceMessageId: row.source_message_id,
    objective: row.objective,
    readScope: row.read_scope,
    writeScope: row.write_scope,
    autonomyMode: row.autonomy_mode,
    riskLevel: row.risk_level,
    payload: row.payload,
    status: row.status,
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    nextRunAt: row.next_run_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function mapOutbox(row: OutboxRow): OutboxEvent {
  return {
    outboxId: row.outbox_id,
    eventType: row.event_type,
    aggregateId: row.aggregate_id,
    payload: row.payload,
    attempts: row.attempts,
  };
}

async function selectTask(client: pg.PoolClient, taskId: string): Promise<TaskRecord> {
  const selected = await client.query<TaskRow>('SELECT * FROM tasks WHERE task_id = $1', [taskId]);
  const row = selected.rows[0];
  if (!row) throw new Error(`Task not found: ${taskId}`);
  return mapTask(row);
}

export class PostgresControlPlaneStore implements ControlPlaneStore {
  readonly #instanceId = `STORE-${randomUUID()}`;

  async createTask(rawInput: CreateTaskInput): Promise<{ task: TaskRecord; created: boolean }> {
    const input = CreateTaskSchema.parse(rawInput);
    return withTransaction(async (client) => {
      const inserted = await client.query<TaskRow>(
        `INSERT INTO tasks(
          task_id, correlation_id, idempotency_key, owner_id, workspace_id,
          conversation_id, source_message_id, objective, read_scope, write_scope,
          autonomy_mode, risk_level, payload, status, max_attempts
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12,$13::jsonb,'QUEUED',$14)
        ON CONFLICT(owner_id, workspace_id, idempotency_key) DO NOTHING
        RETURNING *`,
        [input.taskId, input.correlationId, input.idempotencyKey, input.ownerId, input.workspaceId,
          input.conversationId, input.sourceMessageId, input.objective,
          JSON.stringify(input.readScope), JSON.stringify(input.writeScope),
          input.autonomyMode, input.riskLevel, JSON.stringify(input.payload), input.maxAttempts],
      );
      const newRow = inserted.rows[0];
      if (newRow) {
        await client.query(
          `INSERT INTO outbox_events(event_type, aggregate_id, payload)
           VALUES('TASK_CREATED', $1, $2::jsonb)`,
          [input.taskId, JSON.stringify({ taskId: input.taskId })],
        );
        return { task: mapTask(newRow), created: true };
      }
      const existing = await client.query<TaskRow>(
        `SELECT * FROM tasks WHERE owner_id = $1 AND workspace_id = $2 AND idempotency_key = $3`,
        [input.ownerId, input.workspaceId, input.idempotencyKey],
      );
      const existingRow = existing.rows[0];
      if (!existingRow) throw new Error('Idempotent task lookup failed after conflict.');
      return { task: mapTask(existingRow), created: false };
    });
  }

  async getTask(taskId: string): Promise<TaskRecord | null> {
    const result = await getPool().query<TaskRow>('SELECT * FROM tasks WHERE task_id = $1', [taskId]);
    const row = result.rows[0];
    return row ? mapTask(row) : null;
  }

  async updateTaskStatus(
    taskId: string,
    status: TaskStatus,
    options: Readonly<{ attempt?: number; nextRunAt?: Date | null; lastError?: string | null }> = {},
  ): Promise<TaskRecord> {
    return withTransaction(async (client) => {
      await client.query(
        `UPDATE tasks SET status = $2, attempt = COALESCE($3, attempt), next_run_at = $4,
          last_error = $5, updated_at = now() WHERE task_id = $1`,
        [taskId, status, options.attempt ?? null, options.nextRunAt ?? null, options.lastError ?? null],
      );
      return selectTask(client, taskId);
    });
  }

  async startExecution(record: ExecutionRecord): Promise<void> {
    await getPool().query(
      `INSERT INTO executions(execution_id, task_id, owner_id, workspace_id, executor, status,
        attempt, started_at, finished_at, result, error)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)
       ON CONFLICT(task_id, attempt) DO NOTHING`,
      [record.executionId, record.taskId, record.ownerId, record.workspaceId, record.executor,
        record.status, record.attempt, record.startedAt, record.finishedAt,
        record.result ? JSON.stringify(record.result) : null, record.error],
    );
  }

  async finishExecution(
    executionId: string,
    status: Exclude<ExecutionStatus, 'STARTED'>,
    result: Record<string, unknown> | null = null,
    error: string | null = null,
  ): Promise<void> {
    const updated = await getPool().query(
      `UPDATE executions SET status = $2, result = $3::jsonb, error = $4, finished_at = now()
       WHERE execution_id = $1 AND status = 'STARTED'`,
      [executionId, status, result ? JSON.stringify(result) : null, error],
    );
    if (updated.rowCount !== 1) throw new Error(`Execution cannot be finished: ${executionId}`);
  }

  async createApproval(input: ApprovalInput): Promise<void> {
    await getPool().query(
      `INSERT INTO approvals(approval_id, task_id, owner_id, workspace_id, action, status)
       VALUES($1,$2,$3,$4,$5::jsonb,'PENDING')`,
      [input.approvalId, input.taskId, input.ownerId, input.workspaceId, JSON.stringify(input.action)],
    );
  }

  async decideApproval(input: ApprovalDecisionInput): Promise<ApprovalDecisionResult> {
    return withTransaction(async (client) => {
      const selected = await client.query<{
        approval_id: string;
        task_id: string;
        owner_id: string;
        workspace_id: string;
        status: string;
      }>(
        `SELECT approval_id, task_id, owner_id, workspace_id, status
         FROM approvals WHERE approval_id = $1 FOR UPDATE`,
        [input.approvalId],
      );
      const approval = selected.rows[0];
      if (!approval) throw new Error(`Approval not found: ${input.approvalId}`);
      if (approval.status !== 'PENDING') throw new Error(`Approval already decided: ${input.approvalId}`);
      await client.query(
        `UPDATE approvals SET status = $2, decided_at = now(), decided_by = $3, reason = $4
         WHERE approval_id = $1`,
        [input.approvalId, input.decision, input.actor, input.reason ?? null],
      );
      const nextStatus = input.decision === 'APPROVED' ? 'QUEUED' : 'FAILED';
      await client.query(
        `UPDATE tasks SET status = $2, next_run_at = NULL,
          last_error = CASE WHEN $2 = 'FAILED' THEN 'APPROVAL_REJECTED' ELSE NULL END,
          updated_at = now() WHERE task_id = $1`,
        [approval.task_id, nextStatus],
      );
      if (input.decision === 'APPROVED') {
        await client.query(
          `INSERT INTO outbox_events(event_type, aggregate_id, payload)
           VALUES('TASK_APPROVED', $1, $2::jsonb)`,
          [approval.task_id, JSON.stringify({ taskId: approval.task_id, approvalId: input.approvalId })],
        );
      }
      return {
        approvalId: approval.approval_id,
        taskId: approval.task_id,
        ownerId: approval.owner_id,
        workspaceId: approval.workspace_id,
        decision: input.decision,
      };
    });
  }

  async recordEvidence(input: EvidenceInput): Promise<void> {
    await getPool().query(
      `INSERT INTO evidence_objects(evidence_id, task_id, execution_id, owner_id, workspace_id,
        object_key, sha256, media_type, size_bytes)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT(evidence_id) DO NOTHING`,
      [input.evidenceId, input.taskId, input.executionId ?? null, input.ownerId,
        input.workspaceId, input.objectKey, input.sha256, input.mediaType, input.sizeBytes],
    );
  }

  async appendAudit(event: AuditEventInput): Promise<void> {
    await getPool().query(
      `INSERT INTO audit_events(event_id, task_id, execution_id, correlation_id, owner_id,
        workspace_id, event_type, actor, details)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
       ON CONFLICT(event_id) DO NOTHING`,
      [event.eventId, event.taskId ?? null, event.executionId ?? null, event.correlationId,
        event.ownerId, event.workspaceId, event.eventType, event.actor,
        JSON.stringify(event.details ?? {})],
    );
  }

  async claimOutbox(limit = 50): Promise<OutboxEvent[]> {
    return withTransaction(async (client) => {
      const result = await client.query<OutboxRow>(
        `WITH picked AS (
          SELECT outbox_id FROM outbox_events
          WHERE published_at IS NULL
            AND (locked_at IS NULL OR locked_at < now() - interval '2 minutes')
          ORDER BY outbox_id
          FOR UPDATE SKIP LOCKED
          LIMIT $1
        )
        UPDATE outbox_events AS outbox
        SET locked_at = now(), locked_by = $2, attempts = outbox.attempts + 1
        FROM picked
        WHERE outbox.outbox_id = picked.outbox_id
        RETURNING outbox.outbox_id, outbox.event_type, outbox.aggregate_id,
          outbox.payload, outbox.attempts`,
        [limit, this.#instanceId],
      );
      return result.rows.map(mapOutbox);
    });
  }

  async markOutboxPublished(outboxId: number): Promise<void> {
    const result = await getPool().query(
      `UPDATE outbox_events SET published_at = now(), locked_at = NULL, locked_by = NULL
       WHERE outbox_id = $1 AND locked_by = $2 AND published_at IS NULL`,
      [outboxId, this.#instanceId],
    );
    if (result.rowCount !== 1) throw new Error(`Outbox lease lost: ${outboxId}`);
  }

  async listRecoverableTasks(staleBefore: Date, limit = 100): Promise<TaskRecord[]> {
    const result = await getPool().query<TaskRow>(
      `SELECT * FROM tasks
       WHERE (status = 'RETRY_WAIT' AND next_run_at <= now())
          OR (status = 'RUNNING' AND updated_at < $1)
       ORDER BY updated_at
       LIMIT $2`,
      [staleBefore, limit],
    );
    return result.rows.map(mapTask);
  }

  async healthCheck(): Promise<boolean> {
    const result = await getPool().query<{ ok: number }>('SELECT 1 AS ok');
    return result.rows[0]?.ok === 1;
  }
}
