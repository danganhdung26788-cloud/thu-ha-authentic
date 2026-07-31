import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getPool, withTransaction } from '../db/pool.js';

const DateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, 'Invalid calendar date.');

export const StartSoakCycleSchema = z.object({
  startedOn: DateOnlySchema,
  createdBy: z.string().min(1),
});

export const RecordSoakDaySchema = z.object({
  cycleId: z.string().min(1),
  dayNumber: z.number().int().min(1).max(7),
  soakDate: DateOnlySchema,
  status: z.enum(['PASS', 'FAIL']),
  evidence: z.record(z.string(), z.unknown()).refine(
    (value) => Object.keys(value).length > 0,
    'Soak evidence must not be empty.',
  ),
  recordedBy: z.string().min(1),
});

function addDays(dateOnly: string, days: number): string {
  const date = new Date(`${dateOnly}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export class SoakStore {
  async start(rawInput: unknown) {
    const input = StartSoakCycleSchema.parse(rawInput);
    return withTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('agent-v2-soak-cycle'))");
      const active = await client.query<{ cycle_id: string }>(
        "SELECT cycle_id FROM soak_cycles WHERE status = 'ACTIVE' LIMIT 1",
      );
      if (active.rows[0]) throw new Error(`Active soak cycle already exists: ${active.rows[0].cycle_id}`);
      const cycleId = `SOAK-${randomUUID()}`;
      await client.query(
        `INSERT INTO soak_cycles(cycle_id, started_on, status, created_by)
         VALUES($1,$2,'ACTIVE',$3)`,
        [cycleId, input.startedOn, input.createdBy],
      );
      return { cycleId, startedOn: input.startedOn, status: 'ACTIVE' as const };
    });
  }

  async recordDay(rawInput: unknown) {
    const input = RecordSoakDaySchema.parse(rawInput);
    return withTransaction(async (client) => {
      const cycleResult = await client.query<{
        cycle_id: string;
        started_on: string;
        status: string;
      }>(
        'SELECT cycle_id, started_on, status FROM soak_cycles WHERE cycle_id = $1 FOR UPDATE',
        [input.cycleId],
      );
      const cycle = cycleResult.rows[0];
      if (!cycle) throw new Error(`Soak cycle not found: ${input.cycleId}`);
      if (cycle.status !== 'ACTIVE') throw new Error(`Soak cycle is not ACTIVE: ${input.cycleId}`);
      const expectedDate = addDays(cycle.started_on, input.dayNumber - 1);
      if (input.soakDate !== expectedDate) {
        throw new Error(
          `Soak day ${input.dayNumber} must use ${expectedDate}, received ${input.soakDate}.`,
        );
      }
      await client.query(
        `INSERT INTO soak_days(
          cycle_id, day_number, soak_date, status, evidence, recorded_by
        ) VALUES($1,$2,$3,$4,$5::jsonb,$6)`,
        [
          input.cycleId,
          input.dayNumber,
          input.soakDate,
          input.status,
          JSON.stringify(input.evidence),
          input.recordedBy,
        ],
      );
      if (input.status === 'FAIL') {
        await client.query(
          "UPDATE soak_cycles SET status = 'FAILED', completed_at = now() WHERE cycle_id = $1",
          [input.cycleId],
        );
        return { ...input, cycleStatus: 'FAILED' as const };
      }
      if (input.dayNumber === 7) {
        const days = await client.query<{ day_number: number; status: string }>(
          'SELECT day_number, status FROM soak_days WHERE cycle_id = $1 ORDER BY day_number',
          [input.cycleId],
        );
        const passed = days.rows.length === 7
          && days.rows.every((row, index) => row.day_number === index + 1 && row.status === 'PASS');
        if (!passed) throw new Error('Day 7 cannot complete until Day 1-7 are all recorded as PASS.');
        await client.query(
          "UPDATE soak_cycles SET status = 'PASSED', completed_at = now() WHERE cycle_id = $1",
          [input.cycleId],
        );
        return { ...input, cycleStatus: 'PASSED' as const };
      }
      return { ...input, cycleStatus: 'ACTIVE' as const };
    });
  }

  async latestPassed(): Promise<{ cycleId: string; startedOn: string; completedAt: Date } | null> {
    const result = await getPool().query<{
      cycle_id: string;
      started_on: string;
      completed_at: Date;
    }>(
      `SELECT cycle_id, started_on, completed_at
       FROM soak_cycles WHERE status = 'PASSED'
       ORDER BY completed_at DESC LIMIT 1`,
    );
    const row = result.rows[0];
    return row
      ? { cycleId: row.cycle_id, startedOn: row.started_on, completedAt: row.completed_at }
      : null;
  }
}
