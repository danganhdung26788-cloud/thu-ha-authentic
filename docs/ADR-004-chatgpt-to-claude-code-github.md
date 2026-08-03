# ADR-004 — ChatGPT delegates code implementation to Claude Code through GitHub

- **Status:** Accepted
- **Date:** 2026-08-03
- **Owner:** danganhdung
- **Related:** ADR-003
- **Tracked by:** GitHub Issue #65

## Context

SYSTEM AI WORKFLOW remains centered on ChatGPT. The owner needs one narrow automatic route for software work:

```text
ChatGPT creates a technical task
→ Claude Code implements it
→ GitHub returns code and evidence
→ ChatGPT reviews
→ owner approves merge or deployment
```

Claude Cowork, Gmail transport, a backend Manager agent, a business queue, and multi-AI routing are unnecessary for this code-only route.

ADR-003 established ChatGPT as the only primary brain and normal user interface. It also introduced a read-only Codex specialist inside an MCP bridge. The owner has now selected Claude Code as the sole executor for writing and modifying code. ADR-004 supersedes Codex as the selected code implementation route while preserving the ChatGPT-primary decision and the existing safety boundaries.

## Decision

### Roles

```text
ChatGPT
- understands the owner's request;
- creates the GitHub technical task;
- inspects Claude's branch, diff, checks, and comments;
- creates or reviews the Pull Request;
- performs final acceptance;
- reports to the owner.

Claude Code
- is the sole code executor for this route;
- reads the Issue and repository;
- creates a task branch;
- writes or modifies code;
- adds tests;
- runs allowed checks;
- commits changes;
- reports results and blockers through GitHub.

Owner
- approves merge, deployment, release, rollback, permissions, secrets, and scope expansion.
```

### Transport and evidence

```text
TASK_TRANSPORT=GITHUB_ISSUE
EXECUTION_BRANCH_PREFIX=claude/
IMPLEMENTATION_EVIDENCE=COMMIT_DIFF_TESTS
RETURN_CHANNEL=GITHUB_ISSUE_AND_PR
FINAL_ACCEPTANCE=CHATGPT
```

Gmail is not used for code task transport. Google Drive is not the source of truth for code changes. GitHub is authoritative for the Issue, branch, commit, diff, Pull Request, checks, and review history.

### Trigger

The repository workflow uses the official `anthropics/claude-code-action@v1`.

- Trigger phrase: `@claude`
- Triggering actor: only `danganhdung26788-cloud`
- Authentication: repository secret `CLAUDE_CODE_OAUTH_TOKEN`
- Claude GitHub App: required
- External contributors and bots: cannot trigger the workflow
- Automatic merge: disabled
- Deployment: out of scope

### Claude execution boundary

Claude Code may:

- read repository content;
- edit files inside the Issue scope;
- create a `claude/` branch;
- create commits;
- run explicitly allowed checks;
- comment progress, evidence, blockers, and a PR creation link.

Claude Code may not:

- call another AI;
- merge or deploy;
- alter repository settings, visibility, permissions, credentials, billing, or secrets;
- force-push or rewrite history;
- make unrelated changes;
- expose secrets;
- claim production status without runtime evidence.

`CLAUDE.md` is the repository-level execution contract.

## Pull Request boundary

The official action's safe default may create a branch and return a PR creation link rather than opening a Pull Request automatically. ChatGPT or the owner creates the PR after reviewing that branch. This preserves a human-controlled boundary before code enters the review pipeline.

## Authentication gate

Runtime activation requires owner-controlled setup outside the repository:

1. install the official Claude GitHub App on this repository;
2. run `claude setup-token` locally for a Claude Code OAuth token, or adopt another explicitly approved Anthropic authentication method;
3. store the token as GitHub Actions secret `CLAUDE_CODE_OAUTH_TOKEN`;
4. never place the token in code, Issue text, Pull Request text, logs, or documentation.

A committed workflow without the App and secret is only a technical package, not an active runtime.

## Response contract

Claude's final GitHub response must use one state:

```text
COMPLETED_READY_FOR_CHATGPT_REVIEW
BLOCKED_NEEDS_INPUT
NEED_OWNER_APPROVAL
FAILED_WITH_EVIDENCE
```

For completed work it must include branch, commit, changed files, checks, risks, warnings, and PR creation link if needed.

## Relationship to existing bridge

- ChatGPT remains the primary brain.
- `chatgpt-agent-delegation-bridge/` remains available for its separately approved bounded capabilities.
- `ask_codex` is no longer the selected implementation route for new code tasks under this ADR.
- No new Manager agent, replacement UI, business task database, or general AI queue is introduced.
- `agent-workflow-platform-v2/` remains aborted and must not be resumed or deployed.

## Rollback

Before activation:

- close or revert the implementation PR;
- no runtime rollback is required.

After activation:

- disable the `Claude Code` GitHub Actions workflow;
- revoke or rotate `CLAUDE_CODE_OAUTH_TOKEN`;
- uninstall or restrict the Claude GitHub App;
- revert the enabling commit if needed;
- preserve Issues, branches, commits, PRs, and logs as audit evidence.

Rollback must not delete historical evidence or rewrite Git history.

## Acceptance criteria

```text
CHATGPT_PRIMARY_BRAIN=true
CLAUDE_CODE_SOLE_CODE_EXECUTOR=true
CLAUDE_COWORK_USED=false
GMAIL_TRANSPORT=false
OTHER_AI_CALLED=false
TASK_TRANSPORT=GITHUB_ISSUE
RESULT_TRANSPORT=GITHUB_ISSUE_AND_PR
OWNER_ONLY_TRIGGER=true
BRANCH_PREFIX=claude/
TEST_EVIDENCE_REQUIRED=true
AUTO_MERGE=false
DEPLOY=false
SECRET_IN_REPOSITORY=false
FINAL_ACCEPTANCE=CHATGPT
OWNER_APPROVAL_FOR_MERGE_AND_DEPLOY=true
```

## Current implementation status

```text
TECHNICAL_PACKAGE=IN_PROGRESS
CLAUDE_GITHUB_APP=OWNER_SETUP_REQUIRED
CLAUDE_CODE_OAUTH_TOKEN=OWNER_SETUP_REQUIRED
RUNTIME_ACTIVE=false
```
