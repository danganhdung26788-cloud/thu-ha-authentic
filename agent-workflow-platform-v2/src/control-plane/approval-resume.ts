import { z } from 'zod';
import { ManagerDecisionSchema } from '../contracts/execution-context.js';
import { getPool, withTransaction } from '../db/pool.js';
import { ActionRequestSchema } from '../policy/policy-engine.js';

const ApprovedActionSchema = z.object({
  manager: ManagerDecisionSchema,
  policy: z.object({
    outcome: z.enum(['AUTO_APPROVE', 'REQUIRE_APPROVAL', 'DENY']),
    reason: z.string().min(1),
  }),
  actionRequest: ActionRequestSchema,
});

export type ApprovedActionLease = Readonly<{
  approvalId: string;
  executionId: string;
  action: z.infer<typeof ApprovedActionSchema>;
}>;

export async function claimApprovedAction(
  taskId: string,
  executionId: string,
): Promise<ApprovedActionLease | null> {
  return withTransaction(async (client) => {
    const selected = await client.query<{
      approval_id: string;
      action: unknown;
    }>(
      `SELECT approval_id, action
       FROM approvals
       WHERE task_id = $1
         AND status = 'APPROVED'
         AND executed_at IS NULL
         AND (
           resume_claimed_at IS NULL
           OR resume_claimed_at < now() - interval '5 minutes'
           OR resume_claimed_by = $2
         )
       ORDER BY decided_at
       FOR UPDATE SKIP LOCKED
       LIMIT 1`,
      [taskId, executionId],
    );
    const row = selected.rows[0];
    if (!row) return null;
    const action = ApprovedActionSchema.parse(row.action);
    const updated = await client.query(
      `UPDATE approvals
       SET resume_claimed_at = now(), resume_claimed_by = $2
       WHERE approval_id = $1 AND status = 'APPROVED' AND executed_at IS NULL`,
      [row.approval_id, executionId],
    );
    if (updated.rowCount !== 1) throw new Error(`Approved action lease lost: ${row.approval_id}`);
    return { approvalId: row.approval_id, executionId, action };
  });
}

export async function completeApprovedAction(
  approvalId: string,
  executionId: string,
): Promise<void> {
  const updated = await getPool().query(
    `UPDATE approvals SET executed_at = now()
     WHERE approval_id = $1
       AND status = 'APPROVED'
       AND executed_at IS NULL
       AND resume_claimed_by = $2`,
    [approvalId, executionId],
  );
  if (updated.rowCount !== 1) throw new Error(`Approved action cannot be completed: ${approvalId}`);
}

export async function releaseApprovedAction(
  approvalId: string,
  executionId: string,
): Promise<void> {
  await getPool().query(
    `UPDATE approvals
     SET resume_claimed_at = NULL, resume_claimed_by = NULL
     WHERE approval_id = $1
       AND status = 'APPROVED'
       AND executed_at IS NULL
       AND resume_claimed_by = $2`,
    [approvalId, executionId],
  );
}
