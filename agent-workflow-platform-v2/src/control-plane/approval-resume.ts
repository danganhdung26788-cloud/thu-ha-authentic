import { z } from 'zod';
import { ManagerDecisionSchema } from '../contracts/execution-context.js';
import { withTransaction } from '../db/pool.js';
import { ActionRequestSchema } from '../policy/policy-engine.js';

const ApprovedActionSchema = z.object({
  manager: ManagerDecisionSchema,
  policy: z.object({
    outcome: z.enum(['AUTO_APPROVE', 'REQUIRE_APPROVAL', 'DENY']),
    reason: z.string().min(1),
  }),
  actionRequest: ActionRequestSchema,
});

export type ApprovedAction = Readonly<{
  approvalId: string;
  action: z.infer<typeof ApprovedActionSchema>;
}>;

export async function consumeApprovedAction(taskId: string): Promise<ApprovedAction | null> {
  return withTransaction(async (client) => {
    const selected = await client.query<{
      approval_id: string;
      action: unknown;
    }>(
      `SELECT approval_id, action
       FROM approvals
       WHERE task_id = $1 AND status = 'APPROVED' AND executed_at IS NULL
       ORDER BY decided_at
       FOR UPDATE SKIP LOCKED
       LIMIT 1`,
      [taskId],
    );
    const row = selected.rows[0];
    if (!row) return null;
    const action = ApprovedActionSchema.parse(row.action);
    const updated = await client.query(
      `UPDATE approvals SET executed_at = now()
       WHERE approval_id = $1 AND status = 'APPROVED' AND executed_at IS NULL`,
      [row.approval_id],
    );
    if (updated.rowCount !== 1) throw new Error(`Approved action lease lost: ${row.approval_id}`);
    return { approvalId: row.approval_id, action };
  });
}
