import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { BridgeConfig } from '../config.js';
import type {
  DelegationResult,
  HermesExecuteInput,
  HermesInspectInput,
  WorkspaceRegistration,
} from '../contracts.js';
import { redactSecrets } from '../redaction.js';

const AdapterResultSchema = z.object({
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

export class HermesSpecialist {
  constructor(readonly config: BridgeConfig) {}

  async inspect(
    workspace: WorkspaceRegistration,
    input: HermesInspectInput,
  ): Promise<DelegationResult> {
    const requestId = input.idempotencyKey ?? `HERMES-${randomUUID()}`;
    if (!this.config.hermes.enabled) return this.blocked(requestId, 'HERMES_DISABLED', 'Hermes delegation is disabled.');
    if (!workspace.allowHermesRead) {
      return this.blocked(requestId, 'HERMES_READ_NOT_ALLOWED', 'Hermes read access is not allowed for this workspace.');
    }
    const readScope = [input.cwd ?? '.'];
    return this.executeAdapter(requestId, workspace, {
      context: {
        taskId: requestId,
        correlationId: `CORR-${randomUUID()}`,
        ownerId: this.config.ownerId,
        workspaceId: workspace.workspaceId,
        readScope,
        writeScope: [],
        autonomyMode: 'READ_ONLY',
        riskLevel: 'LOW',
      },
      executor: 'HERMES',
      objective: `Inspect ${input.kind} state requested explicitly by ChatGPT.`,
      instructions: 'Perform exactly the supplied read-only inspection. Do not mutate files, processes, services, tasks, or settings.',
      requestedTools: ['runtime.inspect'],
      toolCalls: [{
        toolId: 'runtime.inspect',
        input: {
          kind: input.kind,
          names: input.names,
          ...(input.cwd ? { cwd: input.cwd } : {}),
        },
      }],
    }, this.config.defaultTimeoutSeconds);
  }

  async execute(
    workspace: WorkspaceRegistration,
    input: HermesExecuteInput,
  ): Promise<DelegationResult> {
    const requestId = input.idempotencyKey ?? `HERMES-${randomUUID()}`;
    if (!this.config.hermes.enabled) return this.blocked(requestId, 'HERMES_DISABLED', 'Hermes delegation is disabled.');
    if (!workspace.allowHermesWrite) {
      return this.blocked(requestId, 'HERMES_WRITE_NOT_ALLOWED', 'Hermes write access is not allowed for this workspace.');
    }
    const requestedTools = [...new Set(input.operations.map((operation) => operation.toolId))];
    return this.executeAdapter(requestId, workspace, {
      context: {
        taskId: requestId,
        correlationId: `CORR-${randomUUID()}`,
        ownerId: this.config.ownerId,
        workspaceId: workspace.workspaceId,
        readScope: input.readPaths,
        writeScope: input.writePaths,
        autonomyMode: 'SANDBOX_HIGH',
        riskLevel: 'HIGH',
      },
      executor: 'HERMES',
      objective: input.objective,
      instructions: [
        'ChatGPT explicitly selected this bounded Hermes execution after user-facing approval.',
        input.context ? `Context: ${input.context}` : '',
        'Execute only the structured operations supplied. Do not infer or add extra actions.',
      ].filter(Boolean).join('\n'),
      requestedTools,
      toolCalls: input.operations,
    }, input.timeoutSeconds ?? this.config.defaultTimeoutSeconds);
  }

  private async executeAdapter(
    requestId: string,
    workspace: WorkspaceRegistration,
    body: Record<string, unknown>,
    timeoutSeconds: number,
  ): Promise<DelegationResult> {
    const url = this.config.hermes.adapterUrl;
    const token = this.config.hermes.adapterToken;
    if (!url || !token) return this.blocked(requestId, 'HERMES_NOT_CONFIGURED', 'Hermes adapter is not configured.');
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error('Hermes delegation timed out.')),
      timeoutSeconds * 1_000,
    );
    timer.unref();
    try {
      const response = await fetch(new URL('/v1/execute', url), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'x-owner-id': this.config.ownerId,
          'x-workspace-id': workspace.workspaceId,
          'x-correlation-id': String((body.context as Record<string, unknown>).correlationId),
          'x-idempotency-key': requestId,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`Hermes adapter HTTP ${response.status}: ${text}`);
      const result = AdapterResultSchema.parse(JSON.parse(text));
      return {
        requestId,
        target: 'HERMES',
        status: result.status === 'SUCCEEDED' ? 'SUCCEEDED' : 'FAILED',
        summary: result.summary,
        result: result.output,
        warnings: result.status === 'WAITING_APPROVAL'
          ? ['Hermes adapter requested additional approval. No further action was executed.']
          : [],
        evidence: result.evidence,
        retryable: result.retryable,
        ...(result.errorCode ? { errorCode: result.errorCode } : {}),
      };
    } catch (error) {
      const message = redactSecrets(error, this.config.maxOutputBytes);
      return {
        requestId,
        target: 'HERMES',
        status: 'FAILED',
        summary: message,
        result: {},
        warnings: [],
        evidence: [],
        retryable: /timeout|temporar|unavailable|connection|econn/iu.test(message),
        errorCode: 'HERMES_DELEGATION_FAILED',
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private blocked(requestId: string, errorCode: string, summary: string): DelegationResult {
    return {
      requestId,
      target: 'HERMES',
      status: 'BLOCKED',
      summary,
      result: {},
      warnings: [],
      evidence: [],
      retryable: false,
      errorCode,
    };
  }
}
