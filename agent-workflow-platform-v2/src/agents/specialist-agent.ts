import { Agent, Runner } from '@openai/agents';
import { z } from 'zod';
import { getEnv } from '../config/env.js';
import type { ExecutionContext } from '../contracts/execution-context.js';
import { getConfiguredModelProvider } from '../models/model-provider.js';
import { AgentRegistryStore } from '../registry/agent-registry.js';

const SpecialistOutputSchema = z.object({
  summary: z.string().min(1),
  result: z.record(z.string(), z.unknown()).default({}),
  warnings: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1),
});

export type SpecialistOutput = z.infer<typeof SpecialistOutputSchema>;

export async function runSpecialistAgent(
  context: ExecutionContext,
  objective: string,
  instructions: string,
): Promise<SpecialistOutput> {
  const registered = await new AgentRegistryStore().get('specialist');
  if (registered?.status !== 'ACTIVE') throw new Error('Specialist Agent is not ACTIVE.');
  const env = getEnv();
  const model = env.SPECIALIST_MODEL.trim()
    || env.OPENAI_SPECIALIST_MODEL?.trim()
    || registered.model?.trim();
  if (!model) throw new Error('Specialist model is not configured.');
  const agent = new Agent({
    name: registered.displayName,
    model,
    outputType: SpecialistOutputSchema,
    instructions: [
      'Complete the bounded analytical task using only the supplied content.',
      'Do not claim that files, systems, APIs or external tools were changed.',
      'Preserve source meaning and identify uncertainty explicitly.',
      'Return structured output only.',
    ].join('\n'),
  });
  const runner = new Runner({
    modelProvider: getConfiguredModelProvider(),
    tracingDisabled: env.OPENAI_AGENTS_DISABLE_TRACING === '1',
    workflowName: 'workflow-v2-specialist',
    traceIncludeSensitiveData: false,
  });
  const response = await runner.run(agent, [
    `TASK_ID=${context.taskId}`,
    `OWNER_ID=${context.ownerId}`,
    `WORKSPACE_ID=${context.workspaceId}`,
    `OBJECTIVE=${objective}`,
    `INSTRUCTIONS=${instructions}`,
  ].join('\n'), { context, maxTurns: env.AGENT_MAX_TURNS });
  if (!response.finalOutput) throw new Error('Specialist Agent returned no structured output.');
  return response.finalOutput;
}
