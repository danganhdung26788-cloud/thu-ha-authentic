import type { ExecutionContext, ManagerDecision } from '../contracts/execution-context.js';
import { ToolRegistryStore, type ToolRegistrationInput } from './tool-registry.js';

const identities: Record<ManagerDecision['executor'], string> = {
  CHATGPT: 'manager',
  CODEX: 'codex',
  HERMES: 'hermes',
  CLAUDE_REVIEW: 'claude-review',
  SPECIALIST_AGENT: 'specialist',
};

const expectedAdapters: Partial<Record<ManagerDecision['executor'], ReadonlySet<string>>> = {
  CODEX: new Set(['CODEX']),
  HERMES: new Set(['HERMES']),
  CLAUDE_REVIEW: new Set(['CLAUDE_REVIEW']),
  SPECIALIST_AGENT: new Set(['SPECIALIST_AGENT']),
  CHATGPT: new Set(['SPECIALIST_AGENT']),
};

export type RoutingAuthorization = Readonly<{
  agentId: string;
  tools: ToolRegistrationInput[];
  mutating: boolean;
  deepIntervention: boolean;
}>;

export async function authorizeManagerTools(
  context: ExecutionContext,
  manager: ManagerDecision,
): Promise<RoutingAuthorization> {
  const agentId = identities[manager.executor];
  const tools = await new ToolRegistryStore().authorize(
    agentId,
    manager.requestedTools,
    context.ownerId,
    context.workspaceId,
  );
  const allowedAdapters = expectedAdapters[manager.executor];
  const wrongAdapter = tools.find((tool) => allowedAdapters && !allowedAdapters.has(tool.adapter));
  if (wrongAdapter) {
    throw new Error(
      `Tool adapter mismatch: executor=${manager.executor}, tool=${wrongAdapter.toolId}, adapter=${wrongAdapter.adapter}`,
    );
  }
  return {
    agentId,
    tools,
    mutating: tools.some((tool) => tool.riskClass !== 'READ'),
    deepIntervention: tools.some((tool) => tool.riskClass === 'DEEP_INTERVENTION'),
  };
}
