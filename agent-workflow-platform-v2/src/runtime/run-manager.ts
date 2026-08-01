import { Runner } from '@openai/agents';
import { createManagerAgent } from '../agents/manager-agent.js';
import { getEnv } from '../config/env.js';
import type { ExecutionContext, ManagerDecision } from '../contracts/execution-context.js';
import { getConfiguredModelProvider } from '../models/model-provider.js';
import { AgentRegistryStore } from '../registry/agent-registry.js';

async function resolveManagerModel(): Promise<string> {
  const registered = await new AgentRegistryStore().get('manager');
  if (registered?.status !== 'ACTIVE') throw new Error('Manager Agent is not ACTIVE.');
  const model = registered.model?.trim()
    || getEnv().MANAGER_MODEL.trim()
    || getEnv().OPENAI_MANAGER_MODEL?.trim();
  if (!model) throw new Error('Manager model is not configured.');
  return model;
}

export async function runManagerDecision(
  context: ExecutionContext,
  request: string,
): Promise<ManagerDecision> {
  const env = getEnv();
  const runner = new Runner({
    modelProvider: getConfiguredModelProvider(),
    tracingDisabled: env.OPENAI_AGENTS_DISABLE_TRACING === '1',
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
  const result = await runner.run(agent, input, {
    context,
    maxTurns: env.AGENT_MAX_TURNS,
  });
  if (!result.finalOutput) throw new Error('Manager Agent completed without a structured decision.');
  return result.finalOutput;
}
