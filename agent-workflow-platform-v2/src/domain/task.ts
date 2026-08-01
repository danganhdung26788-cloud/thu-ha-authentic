import { z } from 'zod';
import {
  AutonomyModeSchema,
  RiskLevelSchema,
} from '../contracts/execution-context.js';

export const TaskStatusSchema = z.enum([
  'QUEUED',
  'RUNNING',
  'WAITING_INPUT',
  'WAITING_APPROVAL',
  'RETRY_WAIT',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
]);

export const CreateTaskSchema = z.object({
  taskId: z.string().min(1),
  correlationId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  ownerId: z.string().min(1),
  workspaceId: z.string().min(1),
  conversationId: z.string().min(1).nullable().default(null),
  sourceMessageId: z.string().min(1).nullable().default(null),
  objective: z.string().min(1),
  readScope: z.array(z.string().min(1)).min(1),
  writeScope: z.array(z.string().min(1)),
  autonomyMode: AutonomyModeSchema,
  riskLevel: RiskLevelSchema,
  payload: z.record(z.string(), z.unknown()).default({}),
  maxAttempts: z.number().int().min(1).max(10).default(3),
});

export const TaskRecordSchema = CreateTaskSchema.extend({
  status: TaskStatusSchema,
  attempt: z.number().int().nonnegative(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  nextRunAt: z.coerce.date().nullable(),
  lastError: z.string().nullable(),
});

export type CreateTaskInput = z.input<typeof CreateTaskSchema>;
export type CreateTask = z.output<typeof CreateTaskSchema>;
export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export type TaskRecord = z.infer<typeof TaskRecordSchema>;
