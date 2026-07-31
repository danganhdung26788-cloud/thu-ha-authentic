import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getPool, withTransaction } from '../db/pool.js';

export const CutoverPhaseSchema = z.enum([
  'V1_ONLY',
  'SHADOW',
  'DUAL_RUN',
  'V2_PRIMARY',
  'V1_DECOMMISSIONED',
]);

export const CutoverTransitionSchema = z.object({
  targetPhase: CutoverPhaseSchema,
  changedBy: z.string().min(1),
  reason: z.string().min(1),
  rollbackUntil: z.coerce.date().nullable().default(null),
  evidence: z.record(z.string(), z.unknown()).default({}),
  soak7Pass: z.boolean().default(false),
  rollbackExpired: z.boolean().default(false),
  backupVerified: z.boolean().default(false),
  ownerApproved: z.boolean().default(false),
});

export type CutoverPhase = z.infer<typeof CutoverPhaseSchema>;
export type CutoverTransitionInput = z.input<typeof CutoverTransitionSchema>;

const forward: Record<CutoverPhase, CutoverPhase | null> = {
  V1_ONLY: 'SHADOW',
  SHADOW: 'DUAL_RUN',
  DUAL_RUN: 'V2_PRIMARY',
  V2_PRIMARY: 'V1_DECOMMISSIONED',
  V1_DECOMMISSIONED: null,
};

const rollback: Partial<Record<CutoverPhase, CutoverPhase>> = {
  SHADOW: 'V1_ONLY',
  DUAL_RUN: 'SHADOW',
  V2_PRIMARY: 'DUAL_RUN',
};

export class CutoverStore {
  async getState(): Promise<{
    phase: CutoverPhase;
    changedBy: string;
    reason: string;
    rollbackUntil: Date | null;
    updatedAt: Date;
  }> {
    const result = await getPool().query<{
      phase: string;
      changed_by: string;
      reason: string;
      rollback_until: Date | null;
      updated_at: Date;
    }>('SELECT phase, changed_by, reason, rollback_until, updated_at FROM cutover_state WHERE singleton = true');
    const row = result.rows[0];
    if (!row) throw new Error('Cutover singleton state is missing.');
    return {
      phase: CutoverPhaseSchema.parse(row.phase),
      changedBy: row.changed_by,
      reason: row.reason,
      rollbackUntil: row.rollback_until,
      updatedAt: row.updated_at,
    };
  }

  async transition(rawInput: CutoverTransitionInput) {
    const input = CutoverTransitionSchema.parse(rawInput);
    return withTransaction(async (client) => {
      const result = await client.query<{
        phase: string;
        rollback_until: Date | null;
      }>('SELECT phase, rollback_until FROM cutover_state WHERE singleton = true FOR UPDATE');
      const row = result.rows[0];
      if (!row) throw new Error('Cutover singleton state is missing.');
      const current = CutoverPhaseSchema.parse(row.phase);
      const allowedForward = forward[current];
      const allowedRollback = rollback[current];
      if (input.targetPhase !== allowedForward && input.targetPhase !== allowedRollback) {
        throw new Error(`Invalid cutover transition: ${current} -> ${input.targetPhase}`);
      }
      if (input.targetPhase === 'V1_DECOMMISSIONED') {
        if (!(input.soak7Pass && input.rollbackExpired && input.backupVerified && input.ownerApproved)) {
          throw new Error('V1 decommission requires 7/7 soak, expired rollback window, verified backup and owner approval.');
        }
      }
      if (input.targetPhase === 'V2_PRIMARY') {
        if (!input.backupVerified || !input.ownerApproved || !input.rollbackUntil) {
          throw new Error('V2_PRIMARY requires verified backup, owner approval and rollback deadline.');
        }
        if (input.rollbackUntil.getTime() <= Date.now()) {
          throw new Error('Rollback deadline must be in the future when entering V2_PRIMARY.');
        }
      }
      await client.query(
        `UPDATE cutover_state SET phase = $1, changed_by = $2, reason = $3,
          rollback_until = $4, updated_at = now() WHERE singleton = true`,
        [input.targetPhase, input.changedBy, input.reason, input.rollbackUntil],
      );
      const transitionId = `CUT-${randomUUID()}`;
      await client.query(
        `INSERT INTO cutover_history(
          transition_id, from_phase, to_phase, changed_by, reason, evidence, rollback_until
        ) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)`,
        [transitionId, current, input.targetPhase, input.changedBy, input.reason,
          JSON.stringify(input.evidence), input.rollbackUntil],
      );
      return {
        transitionId,
        fromPhase: current,
        toPhase: input.targetPhase,
        rollbackUntil: input.rollbackUntil,
      };
    });
  }
}
