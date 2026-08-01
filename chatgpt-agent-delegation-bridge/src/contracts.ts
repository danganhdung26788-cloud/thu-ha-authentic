import { z } from 'zod';

export const OutputLanguageSchema = z.enum(['vi', 'en']).default('vi');

export const WorkspaceRegistrationSchema = z.object({
  workspaceId: z.string().min(1).max(120),
  root: z.string().min(1),
  readRoots: z.array(z.string().min(1)).default(['.']),
  writeRoots: z.array(z.string().min(1)).default([]),
  allowedExecutables: z.array(z.string().min(1)).default([]),
  allowedScripts: z.array(z.string().min(1)).default([]),
  scheduledTaskPrefix: z.string().min(1).max(120).default('SYSTEM-AI-'),
  allowCodexRead: z.boolean().default(true),
  allowCodexWrite: z.boolean().default(false),
  allowLocalRead: z.boolean().default(true),
  allowLocalWrite: z.boolean().default(false),
});

export const WorkspaceRegistrySchema = z.object({
  defaultWorkspaceId: z.string().min(1).max(120),
  workspaces: z.array(WorkspaceRegistrationSchema).min(1),
});

const CommonDelegationSchema = z.object({
  objective: z.string().trim().min(1).max(50_000),
  context: z.string().trim().max(50_000).optional(),
  workspaceId: z.string().trim().min(1).max(120).optional(),
  outputLanguage: OutputLanguageSchema.optional(),
  timeoutSeconds: z.number().int().min(10).max(1_800).optional(),
  idempotencyKey: z.string().trim().min(8).max(200).optional(),
});

export const CodexDelegationInputSchema = CommonDelegationSchema.extend({
  paths: z.array(z.string().trim().min(1).max(1_000)).max(50).default([]),
});

export const LocalInspectInputSchema = z.object({
  workspaceId: z.string().trim().min(1).max(120).optional(),
  kind: z.enum(['system', 'process', 'service', 'scheduled-task', 'docker', 'git']),
  names: z.array(z.string().trim().min(1).max(200)).max(100).default([]),
  cwd: z.string().trim().min(1).max(1_000).optional(),
  idempotencyKey: z.string().trim().min(8).max(200).optional(),
});

export const LocalToolCallSchema = z.object({
  toolId: z.enum(['filesystem.read', 'filesystem.write', 'powershell.execute', 'runtime.inspect', 'scheduled-task.manage']),
  input: z.record(z.string(), z.unknown()),
});

export const LocalExecuteInputSchema = CommonDelegationSchema.extend({
  operations: z.array(LocalToolCallSchema).min(1).max(20),
  readPaths: z.array(z.string().trim().min(1).max(1_000)).min(1).max(100),
  writePaths: z.array(z.string().trim().min(1).max(1_000)).min(1).max(100),
});

export const SpecialistDelegationInputSchema = z.object({
  objective: z.string().trim().min(1).max(50_000),
  context: z.string().trim().max(50_000).optional(),
  outputLanguage: OutputLanguageSchema.optional(),
  timeoutSeconds: z.number().int().min(10).max(600).optional(),
  idempotencyKey: z.string().trim().min(8).max(200).optional(),
});

export const DelegationTargetSchema = z.enum(['CODEX', 'LOCAL_EXECUTOR', 'SPECIALIST_AGENT']);
export const DelegationStatusSchema = z.enum(['SUCCEEDED', 'FAILED', 'BLOCKED']);

export const DelegationResultSchema = z.object({
  requestId: z.string().min(1),
  target: DelegationTargetSchema,
  status: DelegationStatusSchema,
  summary: z.string().min(1),
  result: z.record(z.string(), z.unknown()).default({}),
  warnings: z.array(z.string()).default([]),
  evidence: z.array(z.object({
    name: z.string().min(1),
    mediaType: z.string().min(1),
    contentBase64: z.string().min(1),
  })).default([]),
  retryable: z.boolean().default(false),
  errorCode: z.string().optional(),
});

export type WorkspaceRegistration = z.infer<typeof WorkspaceRegistrationSchema>;
export type WorkspaceRegistryDocument = z.infer<typeof WorkspaceRegistrySchema>;
export type CodexDelegationInput = z.infer<typeof CodexDelegationInputSchema>;
export type LocalInspectInput = z.infer<typeof LocalInspectInputSchema>;
export type LocalExecuteInput = z.infer<typeof LocalExecuteInputSchema>;
export type SpecialistDelegationInput = z.infer<typeof SpecialistDelegationInputSchema>;
export type DelegationResult = z.infer<typeof DelegationResultSchema>;
