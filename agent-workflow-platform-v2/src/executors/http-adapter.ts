import { ExecutorResultSchema, type ExecutorAdapter, type ExecutorRequest, type ExecutorResult } from './contracts.js';

export class HttpExecutorAdapter implements ExecutorAdapter {
  constructor(
    readonly name: string,
    readonly baseUrl: string,
    readonly authToken?: string,
    readonly timeoutMs = 300_000,
  ) {}

  async execute(request: ExecutorRequest): Promise<ExecutorResult> {
    const response = await fetch(new URL('/v1/execute', this.baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.authToken ? { authorization: `Bearer ${this.authToken}` } : {}),
        'x-correlation-id': request.context.correlationId,
        'x-owner-id': request.context.ownerId,
        'x-workspace-id': request.context.workspaceId,
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`${this.name} adapter HTTP ${response.status}`);
    }
    return ExecutorResultSchema.parse(await response.json());
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(new URL('/health', this.baseUrl), {
        signal: AbortSignal.timeout(5_000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}
