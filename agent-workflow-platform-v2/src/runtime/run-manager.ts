import { Runner } from '@openai/agents';
import { createLocalManagerAgent, createManagerAgent } from '../agents/manager-agent.js';
import { getEnv } from '../config/env.js';
import type { ExecutionContext, ManagerDecision } from '../contracts/execution-context.js';
import { extractJsonObject } from '../models/local-json.js';
import { getConfiguredModelProvider } from '../models/model-provider.js';
import { AgentRegistryStore } from '../registry/agent-registry.js';
import {
  deterministicRoutingHint,
  normalizeManagerDecision,
} from './manager-routing-guardrails.js';

async function resolveManagerModel(): Promise<string> {
  const registered = await new AgentRegistryStore().get('manager');
  if (registered?.status !== 'ACTIVE') throw new Error('Manager Agent is not ACTIVE.');
  const env = getEnv();
  const model = env.MANAGER_MODEL.trim()
    || env.OPENAI_MANAGER_MODEL?.trim()
    || registered.model?.trim();
  if (!model) throw new Error('Manager model is not configured.');
  return model;
}

function localInput(
  context: ExecutionContext,
  request: string,
  model: string,
): string {
  const env = getEnv();
  const hint = deterministicRoutingHint(request, context);
  const qwenNoThink = env.MODEL_PROVIDER === 'ollama' && /^qwen3(?::|$)/iu.test(model)
    ? '/no_think'
    : '';
  return [
    qwenNoThink,
    'Route this task under the registered execution contract.',
    `DETERMINISTIC_HINT=${JSON.stringify(hint)}`,
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
  ].filter(Boolean).join('\n');
}

export async function runManagerDecision(
  context: ExecutionContext,
  request: string,
): Promise<ManagerDecision> {
  const env = getEnv();
  const model = await resolveManagerModel();
  const runner = new Runner({
    modelProvider: getConfiguredModelProvider(),
    tracingDisabled: env.OPENAI_AGENTS_DISABLE_TRACING === '1',
    workflowName: 'workflow-v2-routing',
    traceIncludeSensitiveData: false,
  });
  const input = localInput(context, request, model);

  if (env.MODEL_PROVIDER === 'ollama') {
    const agent = createLocalManagerAgent(model);
    const first = await runner.run(agent, input, {
      context,
      maxTurns: env.AGENT_MAX_TURNS,
    });
    if (typeof first.finalOutput !== 'string' || !first.finalOutput.trim()) {
      throw new Error('Local Manager completed without JSON text output.');
    }
    try {
      return normalizeManagerDecision(extractJsonObject(first.finalOutput), request, context);
    } catch (firstError) {
      const retryInput = [
        '/no_think',
        'The previous output was invalid. Return one corrected JSON object only.',
        `VALIDATION_ERROR=${firstError instanceof Error ? firstError.message : String(firstError)}`,
        `PREVIOUS_OUTPUT=${first.finalOutput.slice(0, 4_000)}`,
        input,
      ].join('\n');
      const retry = await runner.run(agent, retryInput, {
        context,
        maxTurns: env.AGENT_MAX_TURNS,
      });
      if (typeof retry.finalOutput !== 'string' || !retry.finalOutput.trim()) {
        throw new Error('Local Manager correction returned no JSON text output.');
      }
      return normalizeManagerDecision(extractJsonObject(retry.finalOutput), request, context);
    }
  }

  const agent = createManagerAgent(model);
  const result = await runner.run(agent, input, {
    context,
    maxTurns: env.AGENT_MAX_TURNS,
  });
  if (!result.finalOutput) throw new Error('Manager Agent completed without a structured decision.');
  return normalizeManagerDecision(result.finalOutput, request, context);
}
