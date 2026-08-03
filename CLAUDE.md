# CLAUDE.md — SYSTEM AI WORKFLOW code execution contract

## Authority

- ChatGPT is the primary orchestrator and final acceptance layer.
- Claude Code is the sole code executor for the GitHub route defined by ADR-004.
- Claude Code must not delegate to Claude Cowork, Codex, Gemini, ChatGPT, Hermes, or any other AI.
- GitHub Issues, branches, commits, Pull Requests, checks, and comments are the task and evidence channel.

## Required workflow

1. Read the complete Issue and linked repository context.
2. Restate the bounded implementation scope in the GitHub progress comment.
3. Inspect the repository before editing.
4. Work only on a `claude/` branch created for the task.
5. Make the smallest complete change that satisfies the acceptance criteria.
6. Add or update tests for behavior changes.
7. Run the relevant existing checks.
8. Commit with a clear message.
9. Report:
   - branch and commit;
   - files changed;
   - checks run and PASS/FAIL;
   - risks, warnings, assumptions, and blockers;
   - PR creation link when a PR is not created automatically.

## Mandatory boundaries

- Do not merge a Pull Request.
- Do not deploy or activate production.
- Do not change repository visibility, branch protection, collaborators, permissions, credentials, GitHub secrets, billing, or external accounts.
- Do not force-push, rewrite history, delete audit evidence, or modify unrelated files.
- Do not write secrets, tokens, passwords, private keys, OAuth values, raw `.env` content, or credentials into code, Issue comments, Pull Requests, logs, fixtures, or documentation.
- Do not call another AI or add an AI router/manager.
- Do not resume or deploy `agent-workflow-platform-v2/`; it is an aborted experiment retained for audit.
- Do not claim runtime, deployment, connection, or production PASS without direct evidence.

## Approval gates

Stop and report `NEED_OWNER_APPROVAL` before any action involving:

- merge;
- deploy, release, rollback, or production activation;
- destructive data or file operations;
- permission, secret, credential, billing, or repository-setting changes;
- a scope expansion beyond the Issue;
- an irreversible or externally visible action.

## Repository-specific checks

For changes under `chatgpt-agent-delegation-bridge/`, run:

```bash
npm --prefix chatgpt-agent-delegation-bridge ci --ignore-scripts
npm --prefix chatgpt-agent-delegation-bridge run check
npm --prefix chatgpt-agent-delegation-bridge test
npm --prefix chatgpt-agent-delegation-bridge run build
```

Use existing project commands for other packages. Never weaken or bypass a failing test merely to obtain PASS.

## Completion states

Use exactly one final state in the GitHub response:

```text
COMPLETED_READY_FOR_CHATGPT_REVIEW
BLOCKED_NEEDS_INPUT
NEED_OWNER_APPROVAL
FAILED_WITH_EVIDENCE
```
