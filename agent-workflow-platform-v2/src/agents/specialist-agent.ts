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

export const SPECIALIST_INSTRUCTIONS = [
  'Complete the bounded analytical task using only the supplied content and clearly stated assumptions.',
  'Answer the user directly; do not describe what an analysis would focus on.',
  'Use the same language as the user. When the objective is Vietnamese, every user-visible sentence must be Vietnamese.',
  'For a general advisory question, provide a useful framework, decision criteria, and concrete examples immediately.',
  'Do not stop at saying that data is missing. Give a provisional answer under explicit assumptions, then list only the missing details that would materially change it.',
  'Ask for clarification only when a safe and useful answer is impossible without a genuine business choice.',
  'Do not claim that files, systems, APIs, or external tools were changed unless execution evidence proves it.',
  'Preserve source meaning and identify uncertainty explicitly.',
  'The summary must be the actual answer, not a meta-comment about the task.',
].join('\n');

export function objectiveIsVietnamese(objective: string): boolean {
  return /[ăâđêôơưàáạảãằắặẳẵầấậẩẫèéẹẻẽềếệểễìíịỉĩòóọỏõồốộổỗờớợởỡùúụủũừứựửữỳýỵỷỹ]/iu.test(objective)
    || /\b(tôi|anh|chị|hãy|giúp|phân tích|đánh giá|quy trình|mức độ|nhiệm vụ|phù hợp|như nào)\b/iu.test(objective);
}

function objectiveLanguageInstruction(objective: string): string {
  return objectiveIsVietnamese(objective)
    ? 'OUTPUT_LANGUAGE=Vietnamese. Use natural, clear Vietnamese only.'
    : 'OUTPUT_LANGUAGE=Match the language used in OBJECTIVE.';
}

function outputSatisfiesLanguageContract(objective: string, output: SpecialistOutput): boolean {
  if (!objectiveIsVietnamese(objective)) return true;
  const visible = [output.summary, ...output.warnings].join(' ');
  return /[ăâđêôơưàáạảãằắặẳẵầấậẩẫèéẹẻẽềếệểễìíịỉĩòóọỏõồốộổỗờớợởỡùúụủũừứựửữỳýỵỷỹ]/iu.test(visible)
    || /\b(và|là|cần|nên|không|với|cho|mức|nhiệm vụ|độ khó|phù hợp)\b/iu.test(visible);
}

function parseLocalOutput(text: string): SpecialistOutput {
  return SpecialistOutputSchema.parse(extractJsonObject(text));
}

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
    objectiveLanguageInstruction(objective),
    `TASK_ID=${context.taskId}`,
    `OWNER_ID=${context.ownerId}`,
    `WORKSPACE_ID=${context.workspaceId}`,
    `OBJECTIVE=${objective}`,
    `ROUTING_INSTRUCTIONS=${instructions}`,
    'Deliver the best useful answer now within the available information.',
  ].filter(Boolean).join('\n');

  if (env.MODEL_PROVIDER === 'ollama') {
    const localAgent = new Agent({
      name: registered.displayName,
      model,
      instructions: [
        SPECIALIST_INSTRUCTIONS,
        'Return exactly one JSON object and no Markdown.',
        'Required keys: summary, result, warnings, confidence.',
        'summary must contain the complete user-facing answer.',
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
    const first = parseLocalOutput(response.finalOutput);
    if (outputSatisfiesLanguageContract(objective, first)) return first;

    const correctionInput = [
      qwenNoThink,
      objectiveLanguageInstruction(objective),
      'The previous JSON violated the output-language contract.',
      'Rewrite it as one valid JSON object only.',
      'Preserve useful content, answer the objective directly, and do not add meta-commentary.',
      `OBJECTIVE=${objective}`,
      `PREVIOUS_JSON=${JSON.stringify(first)}`,
    ].filter(Boolean).join('\n');
    const correction = await runner.run(localAgent, correctionInput, {
      context,
      maxTurns: env.AGENT_MAX_TURNS,
    });
    if (typeof correction.finalOutput !== 'string' || !correction.finalOutput.trim()) {
      throw new Error('Local Specialist language correction returned no JSON text output.');
    }
    const corrected = parseLocalOutput(correction.finalOutput);
    if (!outputSatisfiesLanguageContract(objective, corrected)) {
      throw new Error('Local Specialist failed the Vietnamese output contract after one correction.');
    }
    return corrected;
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
