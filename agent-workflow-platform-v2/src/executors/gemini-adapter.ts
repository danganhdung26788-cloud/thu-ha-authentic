import { GoogleGenAI } from '@google/genai';
import type { ExecutorAdapter, ExecutorRequest, ExecutorResult } from './contracts.js';

export type GeminiGenerateClient = Readonly<{
  generate(input: { model: string; contents: string }): Promise<string>;
}>;

class GoogleGenAiClient implements GeminiGenerateClient {
  readonly #client: GoogleGenAI;

  constructor(apiKey: string, apiVersion: 'v1' | 'v1beta') {
    this.#client = new GoogleGenAI({ apiKey, apiVersion });
  }

  async generate(input: { model: string; contents: string }): Promise<string> {
    const response = await this.#client.models.generateContent({
      model: input.model,
      contents: input.contents,
    });
    const text = response.text?.trim();
    if (!text) throw new Error('Gemini returned an empty response.');
    return text;
  }
}

function buildPrompt(request: ExecutorRequest): string {
  return [
    'You are the Gemini specialist inside Workflow AI V2.',
    'Work only from the supplied objective, instructions and registered read scope.',
    'Do not claim to have opened a source unless its contents were explicitly included.',
    'Return a concise, evidence-aware answer. Mark missing evidence clearly.',
    `TASK_ID: ${request.context.taskId}`,
    `OWNER_ID: ${request.context.ownerId}`,
    `WORKSPACE_ID: ${request.context.workspaceId}`,
    `READ_SCOPE: ${JSON.stringify(request.context.readScope)}`,
    `OBJECTIVE: ${request.objective}`,
    `INSTRUCTIONS: ${request.instructions}`,
    `REQUESTED_TOOLS: ${JSON.stringify(request.requestedTools)}`,
  ].join('\n');
}

export class GeminiExecutorAdapter implements ExecutorAdapter {
  readonly name = 'gemini';
  readonly #model: string;
  readonly #client: GeminiGenerateClient;

  constructor(input: {
    apiKey: string;
    model: string;
    apiVersion?: 'v1' | 'v1beta';
    client?: GeminiGenerateClient;
  }) {
    if (!input.apiKey.trim() && !input.client) throw new Error('Gemini API key is required.');
    if (!input.model.trim()) throw new Error('Gemini model is required.');
    this.#model = input.model;
    this.#client = input.client ?? new GoogleGenAiClient(input.apiKey, input.apiVersion ?? 'v1');
  }

  async execute(request: ExecutorRequest): Promise<ExecutorResult> {
    const allowedTools = new Set(['gemini.analyze', 'gemini.multimodal', 'gemini.cross-check']);
    const unsupported = request.requestedTools.filter((tool) => !allowedTools.has(tool));
    if (unsupported.length) {
      return {
        status: 'FAILED',
        summary: `Gemini adapter rejected unsupported tools: ${unsupported.join(', ')}`,
        output: {},
        evidence: [],
        errorCode: 'GEMINI_TOOL_NOT_ALLOWED',
        retryable: false,
      };
    }

    try {
      const text = await this.#client.generate({
        model: this.#model,
        contents: buildPrompt(request),
      });
      return {
        status: 'SUCCEEDED',
        summary: 'Gemini specialist completed the bounded analysis.',
        output: {
          provider: 'google',
          model: this.#model,
          text,
        },
        evidence: [],
        retryable: false,
      };
    } catch (error) {
      return {
        status: 'FAILED',
        summary: error instanceof Error ? error.message : 'Gemini execution failed.',
        output: {},
        evidence: [],
        errorCode: 'GEMINI_EXECUTION_FAILED',
        retryable: true,
      };
    }
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}
