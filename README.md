# SYSTEM AI WORKFLOW — ChatGPT-primary architecture

The primary system is the ChatGPT project itself.

```text
ChatGPT
  ├─ reasons and answers directly
  ├─ uses native and connected tools
  ├─ delegates code tasks through GitHub
  │    └─ Claude Code: branch, commit, tests, Issue/PR response
  └─ uses the bounded MCP bridge only for separately approved capabilities
       └─ chatgpt-agent-delegation-bridge
```

## Active architecture

- Primary brain and normal UI: ChatGPT inside SYSTEM AI WORKFLOW.
- Code execution decision: `docs/ADR-004-chatgpt-to-claude-code-github.md`.
- Code executor: Claude Code only.
- Code task transport: GitHub Issue.
- Code result and evidence: branch, commit, diff, Pull Request, checks, and GitHub comments.
- Repository execution contract: `CLAUDE.md`.
- Claude activation workflow: `.github/workflows/claude-code.yml`.
- Setup runbook: `docs/runbooks/CLAUDE_CODE_GITHUB_SETUP.md`.
- Existing bridge decision: `docs/ADR-003-chatgpt-primary-delegation-bridge.md`.
- Existing bounded integration: `chatgpt-agent-delegation-bridge/`.
- Backend Manager/router: none.
- Replacement chat/task platform: none.
- Business database/queue: none.
- Automatic merge/deploy: none.

The Codex read-only specialist retained inside the existing bridge is not the selected implementation route for new code tasks under ADR-004.

## Activation status

```text
TECHNICAL_PACKAGE=IMPLEMENTED_ON_FEATURE_BRANCH
CLAUDE_GITHUB_APP=OWNER_SETUP_REQUIRED
CLAUDE_CODE_OAUTH_TOKEN=OWNER_SETUP_REQUIRED
RUNTIME_ACTIVE=false
AUTO_MERGE=false
AUTO_DEPLOY=false
```

A merged workflow alone does not activate Claude Code. The owner must install the official Claude GitHub App and store `CLAUDE_CODE_OAUTH_TOKEN` as a GitHub Actions secret.

## Aborted experiment

`agent-workflow-platform-v2/` is retained temporarily for audit and safe removal planning only. It must not be deployed, resumed, or used as the foundation of the rebuilt system.

See `agent-workflow-platform-v2/EXPERIMENT_ABORTED.md`.
