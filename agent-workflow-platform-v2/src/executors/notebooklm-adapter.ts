import type { ExecutorAdapter, ExecutorRequest, ExecutorResult } from './contracts.js';

function notebookTitle(request: ExecutorRequest): string {
  const compact = request.objective.replace(/\s+/g, ' ').trim().slice(0, 80);
  return `${request.context.taskId} — ${compact}`;
}

export class NotebookLmSourcePackageAdapter implements ExecutorAdapter {
  readonly name = 'notebooklm';

  async execute(request: ExecutorRequest): Promise<ExecutorResult> {
    const allowedTools = new Set([
      'notebooklm.prepare-source-package',
      'notebooklm.register-result',
    ]);
    const unsupported = request.requestedTools.filter((tool) => !allowedTools.has(tool));
    if (unsupported.length) {
      return {
        status: 'FAILED',
        summary: `NotebookLM adapter rejected unsupported tools: ${unsupported.join(', ')}`,
        output: {},
        evidence: [],
        errorCode: 'NOTEBOOKLM_TOOL_NOT_ALLOWED',
        retryable: false,
      };
    }

    if (request.requestedTools.includes('notebooklm.register-result')) {
      return {
        status: 'HANDOFF',
        summary: 'NotebookLM result registration requires the reviewed result, citations and notebook link.',
        output: {
          requiredFields: ['notebookUrl', 'resultText', 'citations', 'reviewedBy'],
          taskId: request.context.taskId,
          ownerId: request.context.ownerId,
          workspaceId: request.context.workspaceId,
        },
        evidence: [],
        retryable: false,
      };
    }

    return {
      status: 'HANDOFF',
      summary: 'Prepared a source-grounded NotebookLM research package. Notebook creation and querying remain an explicit Google UI handoff until an official runtime API is available.',
      output: {
        mode: 'SOURCE_PACKAGE_ONLY',
        notebookTitle: notebookTitle(request),
        objective: request.objective,
        researchPrompt: request.instructions,
        sourceManifest: request.context.readScope.map((source, index) => ({
          order: index + 1,
          source,
          ownerId: request.context.ownerId,
          workspaceId: request.context.workspaceId,
        })),
        requiredReturn: {
          notebookUrl: true,
          groundedAnswer: true,
          citations: true,
          generatedArtifacts: ['briefing', 'mind-map', 'slide-deck', 'audio-overview'],
        },
        restrictions: [
          'Do not make the notebook public by default.',
          'Do not add sources outside the registered read scope.',
          'Do not treat NotebookLM output as official until reviewed and registered.',
        ],
      },
      evidence: [],
      retryable: false,
    };
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}
