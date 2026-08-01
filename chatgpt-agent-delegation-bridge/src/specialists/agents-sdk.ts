import { randomUUID } from 'node:crypto';
import { Agent, OpenAIProvider, Runner } from '@openai/agents';
import type { BridgeConfig } from '../config.js';
import type { DelegationResult, SpecialistDelegationInput } from '../contracts.js';
import { redactSecrets } from '../redaction.js';

export class AgentsSdkSpecialist {
  readonly #runner?: Runner;
  readonly #agent?: Agent;

  constructor(readonly config: BridgeConfig) {
    if (!config.specialist.enabled) return;
    if (!config.specialist.model || !config.specialist.apiKey) {
      throw new Error('Agents SDK specialist is enabled without explicit model credentials.');
    }
    const provider = new OpenAIProvider({
      apiKey: config.specialist.apiKey,
      baseURL: config.specialist.baseUrl,
      useResponses: config.specialist.useResponses,
      strictFeatureValidation: true,
    });
    this.#runner = new Runner({
      modelProvider: provider,
      tracingDisabled: true,
      workflowName: 'chatgpt-explicit-specialist-delegation',
      traceIncludeSensitiveData: false,
    });
    this.#agent = new Agent({
      name: 'Explicit Specialist Agent',
      model: config.specialist.model,
      instructions: [
        'You are a specialist invoked explicitly by ChatGPT.',
        'ChatGPT remains the primary brain, owns the conversation, and will evaluate your answer.',
        'Complete only the bounded specialist request supplied to you.',
        'Do not route to another target and do not claim access to tools or data not provided.',
        'Return the substantive answer, not meta-commentary about how you would answer.',
        'Match the requested output language.',
        'State assumptions and uncertainty clearly.',
      ].join('\n'),
    });
  }

  async run(input: SpecialistDelegationInput): Promise<DelegationResult> {
    const requestId = input.idempotencyKey ?? `SPECIALIST-${randomUUID()}`;
    if (!this.config.specialist.enabled || !this.#runner || !this.#agent) {
      return {
        requestId,
        target: 'SPECIALIST_AGENT',
        status: 'BLOCKED',
        summary: 'Agents SDK specialist is disabled. No fallback provider was used.',
        result: {},
        warnings: [],
        evidence: [],
        retryable: false,
        errorCode: 'SPECIALIST_AGENT_DISABLED',
      };
    }
    const controller = new AbortController();
    const timeoutSeconds = input.timeoutSeconds ?? Math.min(this.config.defaultTimeoutSeconds, 600);
    const timer = setTimeout(
      () => controller.abort(new Error('Agents SDK specialist timed out.')),
      timeoutSeconds * 1_000,
    );
    timer.unref();
    const language = input.outputLanguage ?? 'vi';
    const prompt = [
      `OUTPUT_LANGUAGE=${language === 'vi' ? 'Vietnamese' : 'English'}`,
      `OBJECTIVE=${input.objective}`,
      input.context ? `CONTEXT=${input.context}` : '',
      'Return a complete specialist answer for ChatGPT to use. Do not ask the end user directly unless the task is impossible without one specific missing fact.',
    ].filter(Boolean).join('\n');
    try {
      const result = await this.#runner.run(this.#agent, prompt, {
        maxTurns: this.config.specialist.maxTurns,
        signal: controller.signal,
      });
      const output = typeof result.finalOutput === 'string'
        ? result.finalOutput.trim()
        : JSON.stringify(result.finalOutput);
      if (!output) throw new Error('Agents SDK specialist returned no final output.');
      return {
        requestId,
        target: 'SPECIALIST_AGENT',
        status: 'SUCCEEDED',
        summary: output,
        result: { lastAgent: result.lastAgent?.name ?? 'Explicit Specialist Agent' },
        warnings: [],
        evidence: [],
        retryable: false,
      };
    } catch (error) {
      const message = redactSecrets(error, this.config.maxOutputBytes);
      return {
        requestId,
        target: 'SPECIALIST_AGENT',
        status: 'FAILED',
        summary: message,
        result: {},
        warnings: [],
        evidence: [],
        retryable: /timeout|temporar|unavailable|connection/iu.test(message),
        errorCode: 'SPECIALIST_AGENT_FAILED',
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
