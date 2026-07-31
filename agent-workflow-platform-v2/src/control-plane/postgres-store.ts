import type pg from 'pg';
import { CreateTaskSchema, TaskRecordSchema, type CreateTaskInput, type TaskRecord, type TaskStatus } from '../domain/task.js';
import type { ExecutionRecord, ExecutionStatus } from '../domain/execution.js';
import { getPool, withTransaction } from '../db/pool.js';
import type { ApprovalInput, AuditEventInput, ControlPlaneStore } from './store.js';

type TaskRow = Readonly<{
  task_id: string;
  correlation_id: string;
  idempotency_key: string;
  owner_id: string;
  workspace_id: string;
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

function mapTask(row: TaskRow): TaskRecord {
  return TaskRecordSchema.parse({
    taskId: row.task_id,
    correlationId: row.correlation_id,
    idempotencyKey: row.idempotency_key,
    ownerId: row.owner_id,
    workspaceId: row.workspace_id,
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

async function selectTask(client: pg.PoolClient, taskId: string): Promise<TaskRecord> {
  const selected = await client.query<TaskRow>('SELECT * FROM tasks WHERE task_id = $1', [taskId]);
  const row = selected.rows[0];
  if (!row) throw new Error(`Task not found: ${taskId}`);
  return mapTask(row);
}

export class PostgresControlPlaneStore implements ControlPlaneStore {
  async createTask(rawInput: CreateTaskInput): Promise<{ task: TaskRecord; created: boolean }> {
    const input = CreateTaskSchema.parse(rawInput);
    return withTransaction(async (client) => {
      const inserted = await client.query<TaskRow>(
        `INSERT INTO tasks(
          task_id, correlation_id, idempotency_key, owner_id, workspace_id,
          objective, read_scope, write_scope, autonomy_mode, risk_level,
          payload, status, max_attempts
        ) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11::jsonb,'QUEUED',$12)
        ON CONFLICT(owner_id, workspace_id, idempotency_key) DO NOTHING
        RETURNING *`,
        [
          input.taskId,
          input.correlationId,
          input.idempotencyKey,
          input.ownerId,
          input.workspaceId,
          input.objective,
          JSON.stringify(input.readScope),
          JSON.stringify(input.writeScope),
          input.autonomyMode,
          input.riskLevel,
          JSON.stringify(input.payload),
          input.maxAttempts,
        ],
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
        `SELECT * FROM tasks
         WHERE owner_id = $1 AND workspace_id = $2 AND idempotency_key = $3`,
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
        `UPDATE tasks SET
          status = $2,
          attempt = COALESCE($3, attempt),
          next_run_at = $4,
          last_error = $5,
          updated_at = now()
         WHERE task_id = $1`,
        [
          taskId,
          status,
          options.attempt ?? null,
          options.nextRunAt ?? null,
          options.lastError ?? null,
        ],
      );
      return selectTask(client, taskId);
    });
  }

  async startExecution(record: ExecutionRecord): Promise<void> {
    await getPool().query(
      `INSERT INTO executions(
        execution_id, task_id, owner_id, workspace_id, executor, status,
        attempt, started_at, finished_at, result, error
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)
      ON CONFLICT(task_id, attempt) DO NOTHING`,
      [
        record.executionId,
        record.taskId,
        record.ownerId,
        record.workspaceId,
        record.executor,
        record.status,
        record.attempt,
        record.startedAt,
        record.finishedAt,
        record.result ? JSON.stringify(record.result) : null,
        record.error,
      ],
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
    if (updated.rowCount !== 1) {
      throw new Error(`Execution cannot be finished: ${executionId}`);
    }
  }

  async createApproval(input: ApprovalInput): Promise<void> {
    await getPool().query(
      `INSERT INTO approvals(
        approval_id, task_id, owner_id, workspace_id, action, status
      ) VALUES($1,$2,$3,$4,$5::jsonb,'PENDING')`,
      [input.approvalId, input.taskId, input.ownerId, input.workspaceId, JSON.stringify(input.action)],
    );
  }

  async appendAudit(event: AuditEventInput): Promise<void> {
    await getPool().query(
      `INSERT INTO audit_events(
        event_id, task_id, execution_id, correlation_id, owner_id,
        workspace_id, event_type, actor, details
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
      ON CONFLICT(event_id) DO NOTHING`,
      [
        event.eventId,
        event.taskId ?? null,
        event.executionId ?? null,
        event.correlationId,
        event.ownerId,
        event.workspaceId,
        event.eventType,
        event.actor,
        JSON.stringify(event.details ?? {}),
      ],
    );
  }

  async healthCheck(): Promise<boolean> {
    const result = await getPool().query<{ ok: number }>('SELECT 1 AS ok');
    return result.rows[0]?.ok === 1;
  }
}
