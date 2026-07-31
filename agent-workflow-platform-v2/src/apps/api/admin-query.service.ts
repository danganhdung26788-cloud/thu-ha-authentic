import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { getPool } from '../../db/pool.js';
import { createExecutorRegistry } from '../../executors/registry.js';

const ListQuerySchema = z.object({
  ownerId: z.string().min(1).optional(),
  workspaceId: z.string().min(1).optional(),
  status: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

@Injectable()
export class AdminQueryService {
  async overview(rawQuery: unknown): Promise<Record<string, unknown>> {
    const query = ListQuerySchema.parse(rawQuery);
    const params: unknown[] = [];
    const where: string[] = [];
    if (query.ownerId) {
      params.push(query.ownerId);
      where.push(`owner_id = $${params.length}`);
    }
    if (query.workspaceId) {
      params.push(query.workspaceId);
      where.push(`workspace_id = $${params.length}`);
    }
    const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [counts, pending, cutover] = await Promise.all([
      getPool().query<{ status: string; count: string }>(
        `SELECT status, count(*)::text AS count FROM tasks ${filter} GROUP BY status ORDER BY status`,
        params,
      ),
      getPool().query<{ count: string }>(
        `SELECT count(*)::text AS count FROM approvals ${filter ? filter.replaceAll('owner_id', 'owner_id').replaceAll('workspace_id', 'workspace_id') + " AND status = 'PENDING'" : "WHERE status = 'PENDING'"}`,
        params,
      ),
      getPool().query<{
        phase: string;
        changed_by: string;
        reason: string;
        rollback_until: Date | null;
        updated_at: Date;
      }>('SELECT phase, changed_by, reason, rollback_until, updated_at FROM cutover_state WHERE singleton = true'),
    ]);
    return {
      counts: Object.fromEntries(counts.rows.map((row) => [row.status, Number(row.count)])),
      pendingApprovals: Number(pending.rows[0]?.count ?? 0),
      cutover: cutover.rows[0] ?? null,
    };
  }

  async listTasks(rawQuery: unknown): Promise<Record<string, unknown>> {
    const query = ListQuerySchema.parse(rawQuery);
    const params: unknown[] = [];
    const where: string[] = [];
    if (query.ownerId) {
      params.push(query.ownerId);
      where.push(`owner_id = $${params.length}`);
    }
    if (query.workspaceId) {
      params.push(query.workspaceId);
      where.push(`workspace_id = $${params.length}`);
    }
    if (query.status) {
      params.push(query.status);
      where.push(`status = $${params.length}`);
    }
    params.push(query.limit);
    const result = await getPool().query(
      `SELECT task_id AS "taskId", correlation_id AS "correlationId", owner_id AS "ownerId",
        workspace_id AS "workspaceId", objective, autonomy_mode AS "autonomyMode",
        risk_level AS "riskLevel", status, attempt, max_attempts AS "maxAttempts",
        last_error AS "lastError", created_at AS "createdAt", updated_at AS "updatedAt"
       FROM tasks ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY updated_at DESC LIMIT $${params.length}`,
      params,
    );
    return { items: result.rows, limit: query.limit };
  }

  async listApprovals(rawQuery: unknown): Promise<Record<string, unknown>> {
    const query = ListQuerySchema.parse(rawQuery);
    const params: unknown[] = [];
    const where = [`a.status = $1`];
    params.push(query.status ?? 'PENDING');
    if (query.ownerId) {
      params.push(query.ownerId);
      where.push(`a.owner_id = $${params.length}`);
    }
    if (query.workspaceId) {
      params.push(query.workspaceId);
      where.push(`a.workspace_id = $${params.length}`);
    }
    params.push(query.limit);
    const result = await getPool().query(
      `SELECT a.approval_id AS "approvalId", a.task_id AS "taskId", a.owner_id AS "ownerId",
        a.workspace_id AS "workspaceId", a.action, a.status, a.requested_at AS "requestedAt",
        a.decided_at AS "decidedAt", a.decided_by AS "decidedBy", a.reason,
        t.objective, t.risk_level AS "riskLevel"
       FROM approvals a JOIN tasks t ON t.task_id = a.task_id
       WHERE ${where.join(' AND ')} ORDER BY a.requested_at DESC LIMIT $${params.length}`,
      params,
    );
    return { items: result.rows, limit: query.limit };
  }

  async taskDetails(taskId: string): Promise<Record<string, unknown> | null> {
    const taskResult = await getPool().query(
      `SELECT task_id AS "taskId", correlation_id AS "correlationId", idempotency_key AS "idempotencyKey",
        owner_id AS "ownerId", workspace_id AS "workspaceId", objective,
        read_scope AS "readScope", write_scope AS "writeScope", autonomy_mode AS "autonomyMode",
        risk_level AS "riskLevel", payload, status, attempt, max_attempts AS "maxAttempts",
        next_run_at AS "nextRunAt", last_error AS "lastError", created_at AS "createdAt", updated_at AS "updatedAt"
       FROM tasks WHERE task_id = $1`,
      [taskId],
    );
    const task = taskResult.rows[0];
    if (!task) return null;
    const [executions, approvals, audit, evidence] = await Promise.all([
      getPool().query(
        `SELECT execution_id AS "executionId", executor, status, attempt, started_at AS "startedAt",
          finished_at AS "finishedAt", result, error FROM executions WHERE task_id = $1 ORDER BY attempt DESC`,
        [taskId],
      ),
      getPool().query(
        `SELECT approval_id AS "approvalId", action, status, requested_at AS "requestedAt",
          decided_at AS "decidedAt", decided_by AS "decidedBy", reason
         FROM approvals WHERE task_id = $1 ORDER BY requested_at DESC`,
        [taskId],
      ),
      getPool().query(
        `SELECT sequence_id AS "sequenceId", event_type AS "eventType", actor, details,
          created_at AS "createdAt" FROM audit_events WHERE task_id = $1 ORDER BY sequence_id DESC LIMIT 200`,
        [taskId],
      ),
      getPool().query(
        `SELECT evidence_id AS "evidenceId", execution_id AS "executionId", object_key AS "objectKey",
          sha256, media_type AS "mediaType", size_bytes AS "sizeBytes", created_at AS "createdAt"
         FROM evidence_objects WHERE task_id = $1 ORDER BY created_at DESC`,
        [taskId],
      ),
    ]);
    return {
      task,
      executions: executions.rows,
      approvals: approvals.rows,
      audit: audit.rows,
      evidence: evidence.rows,
    };
  }

  async adapterStatus(): Promise<Record<string, unknown>> {
    const entries = createExecutorRegistry().entries();
    const statuses = await Promise.all(entries.map(async ([executor, adapter]) => ({
      executor,
      adapter: adapter.name,
      healthy: await adapter.healthCheck(),
    })));
    return {
      configured: statuses,
      disabledByConfiguration: [
        'GEMINI (no API key/model)',
        'CANVA (no adapter URL/token)',
      ],
    };
  }
}
