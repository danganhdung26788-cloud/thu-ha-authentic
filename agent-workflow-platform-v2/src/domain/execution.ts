import { z } from 'zod';

export const ExecutionStatusSchema = z.enum([
  'STARTED',
  'SUCCEEDED',
  'FAILED',
  'INTERRUPTED',
]);

export const ExecutionRecordSchema = z.object({
  executionId: z.string().min(1),
  taskId: z.string().min(1),
  ownerId: z.string().min(1),
  workspaceId: z.string().min(1),
  executor: z.string().min(1),
  status: ExecutionStatusSchema,
  attempt: z.number().int().min(1),
  startedAt: z.coerce.date(),
  finishedAt: z.coerce.date().nullable(),
  result: z.record(z.string(), z.unknown()).nullable(),
  error: z.string().nullable(),
});

export type ExecutionStatus = z.infer<typeof ExecutionStatusSchema>;
export type ExecutionRecord = z.infer<typeof ExecutionRecordSchema>;
