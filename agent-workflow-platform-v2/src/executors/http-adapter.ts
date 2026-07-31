import { ToolRegistryStore } from '../registry/tool-registry.js';
import { ExecutorResultSchema, type ExecutorAdapter, type ExecutorRequest, type ExecutorResult } from './contracts.js';

const adapterAgentIds: Record<string, string> = {
  hermes: 'hermes',
  codex: 'codex',
  'claude-review': 'claude-review',
  canva: 'canva',
};

export class HttpExecutorAdapter implements ExecutorAdapter {
  constructor(
    readonly name: string,
    readonly baseUrl: string,
    readonly authToken?: string,
    readonly timeoutMs = 300_000,
  ) {}

  async execute(request: ExecutorRequest): Promise<ExecutorResult> {
    const agentId = adapterAgentIds[this.name];
    if (!agentId) throw new Error(`Adapter has no registered agent identity: ${this.name}`);
    const tools = new ToolRegistryStore();
    for (const toolId of request.requestedTools) {
      const allowed = await tools.isGranted(
        agentId,
        toolId,
        request.context.ownerId,
        request.context.workspaceId,
      );
      if (!allowed) throw new Error(`Tool grant denied: agent=${agentId}, tool=${toolId}`);
    }
    const response = await fetch(new URL('/v1/execute', this.baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.authToken ? { authorization: `Bearer ${this.authToken}` } : {}),
        'x-correlation-id': request.context.correlationId,
        'x-idempotency-key': request.context.taskId,
        'x-owner-id': request.context.ownerId,
        'x-workspace-id': request.context.workspaceId,
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`${this.name} adapter HTTP ${response.status}`);
    return ExecutorResultSchema.parse(await response.json());
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(new URL('/health', this.baseUrl), {
        headers: this.authToken ? { authorization: `Bearer ${this.authToken}` } : {},
        signal: AbortSignal.timeout(5_000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}
