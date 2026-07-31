import { Runner } from '@openai/agents';
import { createManagerAgent } from '../agents/manager-agent.js';
import type { ExecutionContext, ManagerDecision } from '../contracts/execution-context.js';
import { AgentRegistryStore } from '../registry/agent-registry.js';

function readMaxTurns(): number {
  const parsed = Number.parseInt(process.env.AGENT_MAX_TURNS ?? '12', 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new Error('AGENT_MAX_TURNS must be an integer from 1 to 100.');
  }
  return parsed;
}

async function resolveManagerModel(): Promise<string> {
  const registered = await new AgentRegistryStore().get('manager');
  if (registered?.status !== 'ACTIVE') throw new Error('Manager Agent is not ACTIVE.');
  const model = registered.model?.trim() || process.env.OPENAI_MANAGER_MODEL?.trim();
  if (!model) throw new Error('Manager model is not configured in Agent Registry or OPENAI_MANAGER_MODEL.');
  return model;
}

export async function runManagerDecision(
  context: ExecutionContext,
  request: string,
): Promise<ManagerDecision> {
  const runner = new Runner({
    tracingDisabled: process.env.OPENAI_AGENTS_DISABLE_TRACING?.trim() === '1',
    workflowName: 'workflow-v2-routing',
    traceIncludeSensitiveData: false,
  });
  const agent = createManagerAgent(await resolveManagerModel());
  const input = [
    'Route this task under the registered execution contract.',
    `TASK_ID=${context.taskId}`,
    `CORRELATION_ID=${context.correlationId}`,
    `OWNER_ID=${context.ownerId}`,
    `WORKSPACE_ID=${context.workspaceId}`,
    `READ_SCOPE=${JSON.stringify(context.readScope)}`,
    `WRITE_SCOPE=${JSON.stringify(context.writeScope)}`,
    `AUTONOMY_MODE=${context.autonomyMode}`,
    `RISK_LEVEL=${context.riskLevel}`,
    '',
    request,
  ].join('\n');
  const result = await runner.run(agent, input, { context, maxTurns: readMaxTurns() });
  if (!result.finalOutput) throw new Error('Manager Agent completed without a structured decision.');
  return result.finalOutput;
}
