import { Agent, Runner } from '@openai/agents';
import { z } from 'zod';
import { getEnv } from '../config/env.js';
import type { ExecutionContext } from '../contracts/execution-context.js';
import { extractJsonObject } from '../models/local-json.js';
import { getConfiguredModelProvider } from '../models/model-provider.js';
import { AgentRegistryStore } from '../registry/agent-registry.js';

const SpecialistOutputSchema = z.object({
  summary: z.string().min(1),
  result: z.record(z.string(), z.unknown()).default({}),
  warnings: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1),
});

export type SpecialistOutput = z.infer<typeof SpecialistOutputSchema>;

const SPECIALIST_INSTRUCTIONS = [
  'Complete the bounded analytical task using only the supplied content.',
  'Do not claim that files, systems, APIs or external tools were changed.',
  'Preserve source meaning and identify uncertainty explicitly.',
].join('\n');

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
  const runner = new Runner({
    modelProvider: getConfiguredModelProvider(),
    tracingDisabled: env.OPENAI_AGENTS_DISABLE_TRACING === '1',
    workflowName: 'workflow-v2-specialist',
    traceIncludeSensitiveData: false,
  });
  const qwenNoThink = env.MODEL_PROVIDER === 'ollama' && /^qwen3(?::|$)/iu.test(model)
    ? '/no_think'
    : '';
  const input = [
    qwenNoThink,
    `TASK_ID=${context.taskId}`,
    `OWNER_ID=${context.ownerId}`,
    `WORKSPACE_ID=${context.workspaceId}`,
    `OBJECTIVE=${objective}`,
    `INSTRUCTIONS=${instructions}`,
  ].filter(Boolean).join('\n');

  if (env.MODEL_PROVIDER === 'ollama') {
    const localAgent = new Agent({
      name: registered.displayName,
      model,
      instructions: [
        SPECIALIST_INSTRUCTIONS,
        'Return exactly one JSON object and no Markdown.',
        'Required keys: summary, result, warnings, confidence.',
        'result must be a JSON object, warnings must be an array of strings, and confidence must be between 0 and 1.',
      ].join('\n'),
    });
    const response = await runner.run(localAgent, input, {
      context,
      maxTurns: env.AGENT_MAX_TURNS,
    });
    if (typeof response.finalOutput !== 'string' || !response.finalOutput.trim()) {
      throw new Error('Local Specialist returned no JSON text output.');
    }
    return SpecialistOutputSchema.parse(extractJsonObject(response.finalOutput));
  }

  const agent = new Agent({
    name: registered.displayName,
    model,
    outputType: SpecialistOutputSchema,
    instructions: `${SPECIALIST_INSTRUCTIONS}\nReturn structured output only.`,
  });
  const response = await runner.run(agent, input, {
    context,
    maxTurns: env.AGENT_MAX_TURNS,
  });
  if (!response.finalOutput) throw new Error('Specialist Agent returned no structured output.');
  return response.finalOutput;
}
