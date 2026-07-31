import { Agent, Runner } from '@openai/agents';
import { z } from 'zod';
import type { ExecutionContext } from '../contracts/execution-context.js';

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
  const model = process.env.OPENAI_SPECIALIST_MODEL?.trim();
  if (!model) throw new Error('OPENAI_SPECIALIST_MODEL is required.');
  const agent = new Agent({
    name: 'Workflow V2 Specialist',
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
    tracingDisabled: process.env.OPENAI_AGENTS_DISABLE_TRACING?.trim() === '1',
    workflowName: 'workflow-v2-specialist',
    traceIncludeSensitiveData: false,
  });
  const response = await runner.run(agent, [
    `TASK_ID=${context.taskId}`,
    `OWNER_ID=${context.ownerId}`,
    `WORKSPACE_ID=${context.workspaceId}`,
    `OBJECTIVE=${objective}`,
    `INSTRUCTIONS=${instructions}`,
  ].join('\n'), { context, maxTurns: 12 });
  if (!response.finalOutput) throw new Error('Specialist Agent returned no structured output.');
  return response.finalOutput;
}
