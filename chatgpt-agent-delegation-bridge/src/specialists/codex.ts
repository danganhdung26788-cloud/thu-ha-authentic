import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Codex } from '@openai/codex-sdk';
import type { BridgeConfig } from '../config.js';
import type { CodexDelegationInput, DelegationResult, WorkspaceRegistration } from '../contracts.js';
import { redactSecrets } from '../redaction.js';

async function git(workspaceRoot: string, args: string[], maxBytes: number): Promise<Readonly<{
  exitCode: number;
  stdout: string;
  stderr: string;
}>> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: workspaceRoot,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let total = 0;
    const collect = (target: Buffer[], chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        child.kill();
        reject(new Error('Git output exceeded bridge limit.'));
        return;
      }
      target.push(Buffer.from(chunk));
    };
    child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk));
    child.once('error', reject);
    child.once('close', (code) => resolve({
      exitCode: code ?? 1,
      stdout: Buffer.concat(stdout).toString('utf8').trim(),
      stderr: Buffer.concat(stderr).toString('utf8').trim(),
    }));
  });
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
    name: 'codex-delegation-result.json',
    mediaType: 'application/json',
    contentBase64: Buffer.from(JSON.stringify(payload, null, 2), 'utf8').toString('base64'),
  };
}

export class CodexSpecialist {
  constructor(readonly config: BridgeConfig) {}

  async run(
    mode: 'read' | 'write',
    workspace: WorkspaceRegistration,
    input: CodexDelegationInput,
  ): Promise<DelegationResult> {
    const requestId = input.idempotencyKey ?? `CODEX-${randomUUID()}`;
    if (!this.config.codex.enabled) {
      return {
        requestId,
        target: 'CODEX',
        status: 'BLOCKED',
        summary: 'Codex delegation is disabled by server configuration.',
        result: {},
        warnings: [],
        evidence: [],
        retryable: false,
        errorCode: 'CODEX_DISABLED',
      };
    }
    if (mode === 'read' && !workspace.allowCodexRead) {
      return this.blocked(requestId, 'CODEX_READ_NOT_ALLOWED', 'Codex read access is not allowed for this workspace.');
    }
    if (mode === 'write' && !workspace.allowCodexWrite) {
      return this.blocked(requestId, 'CODEX_WRITE_NOT_ALLOWED', 'Codex write access is not allowed for this workspace.');
    }

    const before = await snapshot(workspace.root, this.config.maxOutputBytes);
    const codex = new Codex({});
    const thread = codex.startThread({
      workingDirectory: workspace.root,
      sandboxMode: mode === 'read' ? 'read-only' : 'workspace-write',
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
      'You are a specialist called explicitly by ChatGPT. ChatGPT remains the primary assistant and owns the conversation.',
      `MODE=${mode === 'read' ? 'READ_ONLY' : 'WORKSPACE_WRITE'}`,
      `OUTPUT_LANGUAGE=${language === 'vi' ? 'Vietnamese' : 'English'}`,
      `OBJECTIVE=${input.objective}`,
      input.context ? `CONTEXT=${input.context}` : '',
      input.paths.length ? `FOCUS_PATHS=${input.paths.join(', ')}` : '',
      mode === 'read'
        ? 'Inspect and answer. Do not change any file, Git state, dependency, setting, or external system.'
        : 'Work only inside the current repository. Make reviewable changes, run relevant tests, and report exact evidence.',
      'Never change credentials, permissions, billing, repository visibility, or operating-system configuration.',
      'Never force-push, rewrite Git history, or deploy production.',
      'Return a useful specialist result for ChatGPT to evaluate and present to the user.',
    ].filter(Boolean).join('\n');

    try {
      const turn = await thread.run(prompt, { signal: controller.signal });
      const after = await snapshot(workspace.root, this.config.maxOutputBytes);
      const changed = JSON.stringify(before) !== JSON.stringify(after);
      const payload = {
        mode,
        threadId: thread.id,
        response: turn.finalResponse,
        usage: turn.usage,
        itemCount: turn.items.length,
        before,
        after,
      };
      if (mode === 'read' && changed) {
        return {
          requestId,
          target: 'CODEX',
          status: 'BLOCKED',
          summary: 'Codex read-only delegation changed repository state; the result was rejected.',
          result: payload,
          warnings: ['Repository state changed during a read-only call. Review the workspace before continuing.'],
          evidence: [evidence(payload)],
          retryable: false,
          errorCode: 'CODEX_READ_ONLY_VIOLATION',
        };
      }
      return {
        requestId,
        target: 'CODEX',
        status: 'SUCCEEDED',
        summary: turn.finalResponse.trim() || 'Codex completed the delegated task.',
        result: payload,
        warnings: [],
        evidence: [evidence(payload)],
        retryable: false,
      };
    } catch (error) {
      const after = await snapshot(workspace.root, this.config.maxOutputBytes).catch(() => ({ unavailable: true }));
      const message = redactSecrets(error, this.config.maxOutputBytes);
      const payload = { mode, error: message, before, after };
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
