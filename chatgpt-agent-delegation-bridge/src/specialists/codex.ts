import { randomUUID } from 'node:crypto';
import { Codex } from '@openai/codex-sdk';
import type { BridgeConfig } from '../config.js';
import type { CodexDelegationInput, DelegationResult, WorkspaceRegistration } from '../contracts.js';
import { runProcess } from '../host/process-runner.js';
import { redactSecrets } from '../redaction.js';

async function git(
  workspaceRoot: string,
  args: string[],
  maxBytes: number,
): Promise<Readonly<{
  exitCode: number;
  stdout: string;
  stderr: string;
}>> {
  const result = await runProcess({
    executable: process.platform === 'win32' ? 'git.exe' : 'git',
    args,
    cwd: workspaceRoot,
    timeoutMs: 30_000,
    maxOutputBytes: maxBytes,
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function snapshot(root: string, maxBytes: number): Promise<Record<string, unknown>> {
  const [head, status, diffStat] = await Promise.all([
    git(root, ['rev-parse', 'HEAD'], maxBytes),
    git(root, ['status', '--porcelain=v1'], maxBytes),
    git(root, ['diff', '--stat'], maxBytes),
  ]);
  if (head.exitCode !== 0) throw new Error('Codex workspace must be a valid Git repository.');
  return { head: head.stdout, status: status.stdout, diffStat: diffStat.stdout };
}

function evidence(payload: unknown) {
  return {
    name: 'codex-specialist-result.json',
    mediaType: 'application/json',
    contentBase64: Buffer.from(JSON.stringify(payload, null, 2), 'utf8').toString('base64'),
  };
}

function formatInstruction(format: CodexDelegationInput['responseFormat']): string {
  if (format === 'implementation-plan') {
    return 'Return a concrete implementation plan with affected files, ordered steps, tests, risks, and rollback notes. Do not modify anything.';
  }
  if (format === 'unified-diff-proposal') {
    return 'Return a proposed unified diff as text, followed by tests and risks. The diff is a proposal only; do not write files or change Git state.';
  }
  return 'Return a direct technical analysis with findings, evidence, severity, and recommended next actions. Do not modify anything.';
}

export class CodexSpecialist {
  constructor(readonly config: BridgeConfig) {}

  async run(
    workspace: WorkspaceRegistration,
    input: CodexDelegationInput,
  ): Promise<DelegationResult> {
    const requestId = input.idempotencyKey ?? `CODEX-${randomUUID()}`;
    if (!this.config.codex.enabled) {
      return this.blocked(requestId, 'CODEX_DISABLED', 'Codex delegation is disabled by server configuration.');
    }
    if (!workspace.allowCodexRead) {
      return this.blocked(requestId, 'CODEX_READ_NOT_ALLOWED', 'Codex read access is not allowed for this workspace.');
    }

    const before = await snapshot(workspace.root, this.config.maxOutputBytes);
    const codex = new Codex({});
    const thread = codex.startThread({
      workingDirectory: workspace.root,
      sandboxMode: 'read-only',
      approvalPolicy: 'never',
      skipGitRepoCheck: false,
      networkAccessEnabled: this.config.codex.networkAccess,
      webSearchMode: 'disabled',
      modelReasoningEffort: this.config.codex.reasoningEffort,
      ...(this.config.codex.model ? { model: this.config.codex.model } : {}),
    });
    const timeoutSeconds = input.timeoutSeconds ?? this.config.defaultTimeoutSeconds;
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error('Codex delegation timed out.')),
      timeoutSeconds * 1_000,
    );
    timer.unref();

    const language = input.outputLanguage ?? 'vi';
    const prompt = [
      'You are a read-only code specialist called explicitly by ChatGPT.',
      'ChatGPT remains the primary brain, owns the conversation, and will evaluate your answer.',
      'MODE=READ_ONLY_PROPOSAL',
      `OUTPUT_LANGUAGE=${language === 'vi' ? 'Vietnamese' : 'English'}`,
      `OBJECTIVE=${input.objective}`,
      input.context ? `CONTEXT=${input.context}` : '',
      input.paths.length ? `FOCUS_PATHS=${input.paths.join(', ')}` : '',
      formatInstruction(input.responseFormat),
      'Do not change any file, Git state, dependency, setting, or external system.',
      'Do not run commands that mutate files or install dependencies.',
      'Never change credentials, permissions, billing, repository visibility, operating-system configuration, or Git history.',
      'Return a useful specialist result for ChatGPT to evaluate and present or execute separately after approval.',
    ].filter(Boolean).join('\n');

    try {
      const turn = await thread.run(prompt, { signal: controller.signal });
      const after = await snapshot(workspace.root, this.config.maxOutputBytes);
      const changed = JSON.stringify(before) !== JSON.stringify(after);
      const payload = {
        mode: 'READ_ONLY_PROPOSAL',
        responseFormat: input.responseFormat,
        threadId: thread.id,
        response: turn.finalResponse,
        usage: turn.usage,
        itemCount: turn.items.length,
        before,
        after,
      };
      if (changed) {
        return {
          requestId,
          target: 'CODEX',
          status: 'BLOCKED',
          summary: 'Codex changed repository state during a read-only delegation; the result was rejected.',
          result: payload,
          warnings: ['Repository state changed during a read-only specialist call. Review the workspace before continuing.'],
          evidence: [evidence(payload)],
          retryable: false,
          errorCode: 'CODEX_READ_ONLY_VIOLATION',
        };
      }
      return {
        requestId,
        target: 'CODEX',
        status: 'SUCCEEDED',
        summary: turn.finalResponse.trim() || 'Codex completed the read-only delegated analysis.',
        result: payload,
        warnings: [],
        evidence: [evidence(payload)],
        retryable: false,
      };
    } catch (error) {
      const after = await snapshot(workspace.root, this.config.maxOutputBytes).catch(() => ({ unavailable: true }));
      const message = redactSecrets(error, this.config.maxOutputBytes);
      const payload = { mode: 'READ_ONLY_PROPOSAL', error: message, before, after };
      return {
        requestId,
        target: 'CODEX',
        status: 'FAILED',
        summary: message,
        result: payload,
        warnings: [],
        evidence: [evidence(payload)],
        retryable: /timeout|temporar|unavailable|connection/iu.test(message),
        errorCode: 'CODEX_DELEGATION_FAILED',
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private blocked(requestId: string, errorCode: string, summary: string): DelegationResult {
    return {
      requestId,
      target: 'CODEX',
      status: 'BLOCKED',
      summary,
      result: {},
      warnings: [],
      evidence: [],
      retryable: false,
      errorCode,
    };
  }
}
