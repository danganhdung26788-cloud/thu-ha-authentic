import { z } from 'zod';

export const AutonomyModeSchema = z.enum([
  'READ_ONLY',
  'SANDBOX_HIGH',
  'UAT_HIGH',
  'PRODUCTION_GUARDED',
]);

export const RiskLevelSchema = z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);

export const ExecutorSchema = z.enum([
  'CHATGPT',
  'CODEX',
  'HERMES',
  'CLAUDE_REVIEW',
  'SPECIALIST_AGENT',
]);

export type AutonomyMode = z.infer<typeof AutonomyModeSchema>;
export type RiskLevel = z.infer<typeof RiskLevelSchema>;
export type Executor = z.infer<typeof ExecutorSchema>;

export const ExecutionContextSchema = z.object({
  taskId: z.string().min(1),
  correlationId: z.string().min(1),
  ownerId: z.string().min(1),
  workspaceId: z.string().min(1),
  readScope: z.array(z.string().min(1)).min(1),
  writeScope: z.array(z.string().min(1)),
  autonomyMode: AutonomyModeSchema,
  riskLevel: RiskLevelSchema,
});

export type ExecutionContext = z.infer<typeof ExecutionContextSchema>;

export const ManagerDecisionSchema = z.object({
  executor: ExecutorSchema,
  rationale: z.string().min(1),
  nextAction: z.string().min(1),
  requestedTools: z.array(z.string().min(1)),
  requiresApproval: z.boolean(),
});

export type ManagerDecision = z.infer<typeof ManagerDecisionSchema>;

export function parseExecutionContext(input: unknown): ExecutionContext {
  return ExecutionContextSchema.parse(input);
}
