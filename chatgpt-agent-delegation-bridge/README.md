# ChatGPT Agent Delegation Bridge

This package rebuilds SYSTEM AI WORKFLOW around the correct center:

> ChatGPT inside the project is the primary brain and the only normal user interface.

ChatGPT answers directly and uses its native/connected tools whenever possible. It calls this MCP bridge only when it intentionally needs a specialist AI or bounded external executor.

## What this is

- a small stateless MCP server;
- explicit specialist tools selected by ChatGPT;
- Codex delegation through the official Codex SDK;
- Hermes delegation through a bounded authenticated adapter;
- optional specialist agents through OpenAI Agents SDK;
- structured results returned to the same ChatGPT conversation.

## What this is not

- not a replacement chat application;
- not a task management platform;
- not a second conversation engine;
- not a Manager/router model;
- not a PostgreSQL/Redis/BullMQ system;
- not a Shadow/cutover path away from ChatGPT;
- not an automatic fallback to a paid provider.

## Architecture

```text
ChatGPT project
  ├─ direct answer/reasoning
  ├─ native tools and connected apps
  └─ explicit MCP tool call when a specialist is needed
       ├─ ask_codex             read-only
       ├─ execute_codex         repository write; host approval
       ├─ inspect_with_hermes   read-only
       ├─ execute_with_hermes   local mutation; host approval
       └─ ask_specialist_agent  optional Agents SDK agent

Specialist result -> ChatGPT evaluates -> final user response
```

The bridge never selects a target. Target selection is encoded in the MCP tool name chosen by ChatGPT.

## Why Agents SDK is not placed in front of every call

Agents SDK runs model-backed agent loops; it is not a transport. Adding a hidden Manager model after ChatGPT has already selected Codex or Hermes would create a second brain, extra latency, duplicate cost, and conflicting decisions.

Therefore:

- Codex uses its official specialist SDK;
- Hermes uses its bounded specialist adapter;
- a model-backed specialist uses Agents SDK;
- no generic backend Manager is created.

## Tools

### `delegation_health`

Reports configured targets and architecture invariants. It does not create a task.

### `ask_codex`

Read-only code/repository inspection. Codex runs with `sandboxMode=read-only`. Repository state is checked before and after; a read-only state change rejects the result.

### `execute_codex`

Approved repository work. Codex runs with `sandboxMode=workspace-write`, no production deployment, no Git history rewriting, no credential/permission/billing changes, and network disabled by default.

### `inspect_with_hermes`

Bounded read-only system/process/service/Scheduled Task/Docker/Git inspection.

### `execute_with_hermes`

Approved structured operations only. Every operation and read/write scope is explicit. Arbitrary inline shell input is not accepted.

### `ask_specialist_agent`

Optional Agents SDK specialist. It is registered only when a model and provider credential are explicitly configured. There is no silent fallback.

## Security model

- Server-side workspace allowlist.
- Server-side owner identity.
- Read/write capabilities set per workspace.
- Separate read-only and mutating MCP tools.
- MCP annotations expose mutation/destructive behavior to ChatGPT approval handling.
- Host-header allowlist and localhost-only unauthenticated development mode.
- Production refuses unauthenticated startup.
- Secrets are not tool parameters and are redacted from errors.
- Request, output, timeout, path, and operation limits.
- In-memory idempotency only; no business database or queue.

## Setup

Requirements:

- Node.js 22+;
- npm 11+;
- an existing local Codex login when Codex is enabled;
- an existing authenticated Hermes adapter only when Hermes is enabled.

```powershell
Set-Location "D:\HermesAgent\workspace\thu-ha-authentic\chatgpt-agent-delegation-bridge"

Copy-Item .env.example .env
New-Item -ItemType Directory -Force .\config | Out-Null
Copy-Item .\config\workspaces.example.json .\config\workspaces.json

npm install
npm run check
npm test
npm run build
npm start
```

The local endpoint is:

```text
http://127.0.0.1:3210/mcp
```

No separate UI is created.

## ChatGPT custom app connection

For local development, expose the MCP endpoint through a controlled HTTPS tunnel and add the resulting `/mcp` endpoint in ChatGPT developer/connectors settings. Do not expose an unauthenticated development endpoint for routine or production use.

Production deployment must add a supported authenticated boundary, TLS, an allowlisted hostname, and server-side secret storage. The bridge intentionally refuses `NODE_ENV=production` with `MCP_AUTH_MODE=none`.

## Initial safe configuration

The example registry starts with:

```text
Codex read:   allowed
Codex write:  blocked
Hermes read:  allowed
Hermes write: blocked
```

Write access is enabled only after read-only UAT passes and the ChatGPT tool approval behavior is verified.

## Acceptance tests

The first acceptance set is product-first:

1. A normal question is answered directly by ChatGPT; bridge is not called.
2. Current weather uses ChatGPT weather tooling; bridge is not called.
3. A repository review calls `ask_codex` exactly once and returns to ChatGPT.
4. A requested code change selects `execute_codex` and requires approval.
5. A local runtime inspection selects `inspect_with_hermes`.
6. A local mutation selects `execute_with_hermes` and requires approval.
7. A follow-up remains in ChatGPT conversation context; it does not create a bridge task.
8. Disabled specialist targets return `BLOCKED`; no fallback occurs.
9. Duplicate idempotency keys do not execute twice within the process TTL.
10. The bridge has no chat UI, business database, queue, or backend Manager.

## Legacy V2 boundary

`agent-workflow-platform-v2` is not the foundation of this package. The new bridge does not import its UI, database, queue, worker, routing model, or conversation code.

Existing Codex/Hermes execution components may be used only through clean specialist boundaries while they are independently replaced or reviewed.

See `docs/ADR-003-chatgpt-primary-delegation-bridge.md`.
