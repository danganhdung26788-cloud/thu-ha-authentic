# SYSTEM AI WORKFLOW — ChatGPT-primary architecture

The primary system is the ChatGPT project itself.

```text
ChatGPT
  ├─ reasons and answers directly
  ├─ uses native and connected tools
  └─ delegates to a specialist only when needed
       └─ chatgpt-agent-delegation-bridge
```

## Active architecture

- Decision: `docs/ADR-003-chatgpt-primary-delegation-bridge.md`
- New integration: `chatgpt-agent-delegation-bridge/`
- Primary brain and UI: ChatGPT inside SYSTEM AI WORKFLOW
- Backend Manager/router: none
- Replacement chat/task platform: none
- Business database/queue: none

## Aborted experiment

`agent-workflow-platform-v2/` is retained temporarily for audit and safe removal planning only. It must not be deployed, resumed, or used as the foundation of the rebuilt system.

See `agent-workflow-platform-v2/EXPERIMENT_ABORTED.md`.
