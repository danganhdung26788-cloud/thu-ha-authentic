# EXPERIMENT ABORTED — DO NOT DEPLOY

The `agent-workflow-platform-v2` replacement-platform direction is discontinued.

It was built around the wrong product assumption: that SYSTEM AI WORKFLOW needed a second chat UI, task database, queue, worker lifecycle, local Manager model, retry engine, and cutover path.

The accepted architecture is now documented in:

```text
docs/ADR-003-chatgpt-primary-delegation-bridge.md
```

## Correct architecture

- ChatGPT inside the existing project is the only primary brain.
- ChatGPT remains the only normal user interface.
- ChatGPT answers directly and uses native/connected tools first.
- Specialist AI is invoked only through explicit MCP delegation tools when ChatGPT chooses to do so.
- No backend Manager/router model is allowed.
- No replacement chat/task platform is allowed.

## Rules for this directory

```text
DEPLOY=false
RESUME_FEATURE_DEVELOPMENT=false
SHADOW=false
CUTOVER=false
USE_AS_NEW_FOUNDATION=false
DELETE_EVIDENCE=false
```

Preserve this directory temporarily for audit, migration review, and safe removal planning. Do not restart its normal user interface or use it for real work.

Reusable concepts or code must be independently reviewed and copied behind a clean boundary. The new bridge must not import this package's UI, database, queue, worker, conversation, routing, or lifecycle modules.
