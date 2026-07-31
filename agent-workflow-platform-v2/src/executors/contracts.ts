import { z } from 'zod';
import {
  ExecutionContextSchema,
  ExecutorSchema,
  PlannedToolCallSchema,
} from '../contracts/execution-context.js';

export const ExecutorRequestSchema = z.object({
  context: ExecutionContextSchema,
  executor: ExecutorSchema,
  objective: z.string().min(1),
  instructions: z.string().min(1),
  requestedTools: z.array(z.string().min(1)),
  toolCalls: z.array(PlannedToolCallSchema).default([]),
  callbackUrl: z.string().url().optional(),
});

export const ExecutorResultSchema = z.object({
  status: z.enum(['SUCCEEDED', 'FAILED', 'WAITING_APPROVAL', 'HANDOFF']),
  summary: z.string().min(1),
  output: z.record(z.string(), z.unknown()).default({}),
  evidence: z.array(z.object({
    name: z.string().min(1),
    mediaType: z.string().min(1),
    contentBase64: z.string().min(1),
  })).default([]),
  errorCode: z.string().optional(),
  retryable: z.boolean().default(false),
});

export type ExecutorRequest = z.input<typeof ExecutorRequestSchema>;
export type ParsedExecutorRequest = z.output<typeof ExecutorRequestSchema>;
export type ExecutorResult = z.infer<typeof ExecutorResultSchema>;

export interface ExecutorAdapter {
  readonly name: string;
  execute(request: ExecutorRequest): Promise<ExecutorResult>;
  healthCheck(): Promise<boolean>;
}
