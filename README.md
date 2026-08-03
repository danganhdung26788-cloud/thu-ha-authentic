# SYSTEM AI WORKFLOW — ChatGPT-primary architecture

The primary system is the ChatGPT project itself.

```text
ChatGPT
  ├─ reasons and answers directly
  ├─ uses native and connected tools
  └─ delegates only through separately approved bounded capabilities
       └─ chatgpt-agent-delegation-bridge
```

## Active architecture

- Primary brain and normal UI: ChatGPT inside SYSTEM AI WORKFLOW.
- Accepted decision: `docs/ADR-003-chatgpt-primary-delegation-bridge.md`.
- Bounded integration: `chatgpt-agent-delegation-bridge/`.
- Codex, when enabled inside the bridge, is read-only and proposal-only.
- No automatic code executor is active.
- Claude Code workflow, setup contract, Issue template, and activation route have been removed by owner decision.
- Backend Manager/router: none.
- Replacement chat/task platform: none.
- Business database/queue: none.
- Automatic merge/deploy: none.

## Current status

```text
CHATGPT_PRIMARY_BRAIN=true
CLAUDE_ROUTE=false
CLAUDE_WORKFLOW=false
CLAUDE_RUNTIME=false
CLAUDE_SECRET_REQUIRED=false
AUTO_MERGE=false
AUTO_DEPLOY=false
```

Historical Claude-related commits, Pull Requests, Issues, and Action logs remain in Git history for audit. They are not part of the active architecture.

## Aborted experiment

`agent-workflow-platform-v2/` is retained temporarily for audit and safe removal planning only. It must not be deployed, resumed, or used as the foundation of the rebuilt system.

See `agent-workflow-platform-v2/EXPERIMENT_ABORTED.md`.
