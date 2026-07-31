import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getPool } from '../db/pool.js';

export const ShadowStatusSchema = z.enum(['MATCH', 'ACCEPTABLE_DIFFERENCE', 'MISMATCH', 'ERROR']);

export const ShadowRunInputSchema = z.object({
  taskId: z.string().min(1),
  ownerId: z.string().min(1),
  workspaceId: z.string().min(1),
  v1Result: z.record(z.string(), z.unknown()),
  v2Result: z.record(z.string(), z.unknown()),
  acceptedDifference: z.boolean().default(false),
  notes: z.array(z.string()).default([]),
});

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash('sha256').update(stable(value)).digest('hex');
}

export class ShadowRunStore {
  async record(rawInput: unknown) {
    const input = ShadowRunInputSchema.parse(rawInput);
    const v1Sha256 = digest(input.v1Result);
    const v2Sha256 = digest(input.v2Result);
    const exactMatch = v1Sha256 === v2Sha256;
    const status = exactMatch
      ? 'MATCH'
      : input.acceptedDifference
        ? 'ACCEPTABLE_DIFFERENCE'
        : 'MISMATCH';
    const comparison = {
      exactMatch,
      v1Sha256,
      v2Sha256,
      notes: input.notes,
    };
    const shadowRunId = `SHADOW-${randomUUID()}`;
    await getPool().query(
      `INSERT INTO shadow_runs(
        shadow_run_id, task_id, owner_id, workspace_id,
        v1_result, v2_result, comparison, status
      ) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8)`,
      [shadowRunId, input.taskId, input.ownerId, input.workspaceId,
        JSON.stringify(input.v1Result), JSON.stringify(input.v2Result),
        JSON.stringify(comparison), status],
    );
    return { shadowRunId, taskId: input.taskId, status, comparison };
  }

  async summary(ownerId: string, workspaceId: string) {
    const result = await getPool().query<{
      status: string;
      count: string;
    }>(
      `SELECT status, count(*)::text AS count FROM shadow_runs
       WHERE owner_id = $1 AND workspace_id = $2
       GROUP BY status ORDER BY status`,
      [ownerId, workspaceId],
    );
    return result.rows.map((row) => ({
      status: ShadowStatusSchema.parse(row.status),
      count: Number.parseInt(row.count, 10),
    }));
  }
}
