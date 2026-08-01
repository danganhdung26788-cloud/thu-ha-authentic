# ChatGPT Agent Delegation Bridge

This package rebuilds SYSTEM AI WORKFLOW around the correct center:

> ChatGPT inside the project is the primary brain and the only normal user interface.

ChatGPT answers directly and uses its native/connected tools whenever possible. It calls this MCP bridge only when it intentionally needs a specialist AI or bounded external executor.

## What this is

- a small stateless MCP server;
- explicit specialist tools selected by ChatGPT;
- Codex delegation through the official Codex SDK;
- direct bounded Hermes-style host execution inside this package;
- optional specialist agents through OpenAI Agents SDK;
- structured results returned to the same ChatGPT conversation.

## What this is not

- not a replacement chat application;
- not a task management platform;
- not a second conversation engine;
- not a Manager/router model;
- not a PostgreSQL/Redis/BullMQ system;
- not a Shadow/cutover path away from ChatGPT;
- not an automatic fallback to a paid provider;
- not dependent on `agent-workflow-platform-v2` at runtime.

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
- bounded host operations execute directly under the bridge workspace policy;
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

Bounded read-only system/process/service/Scheduled Task/Docker/Git inspection. No V2 adapter, port, or Scheduled Task is required.

### `execute_with_hermes`

Approved structured operations only. Every operation and read/write scope is explicit. The server independently enforces registered roots, scripts, executables, and Scheduled Task prefixes. Arbitrary inline shell input is not accepted.

### `ask_specialist_agent`

Optional Agents SDK specialist. It is registered only when a model and provider credential are explicitly configured. There is no silent fallback.

## Security model

- Server-side workspace allowlist.
- Server-side owner identity.
- Registered read/write roots, scripts, executables, and Scheduled Task prefix.
- Read/write capabilities set per workspace.
- Separate read-only and mutating MCP tools.
- MCP annotations expose mutation/destructive behavior to ChatGPT approval handling.
- Host-header allowlist and localhost-only unauthenticated development mode.
- Production refuses unauthenticated startup.
- Secrets are not tool parameters and are redacted from errors and host output.
- Request, output, timeout, path, and operation limits.
- No shell-based process spawning.
- In-memory idempotency only; no business database or queue.

## ChatGPT availability gate

Building and testing the MCP server is separate from connecting it to this ChatGPT project.

Current OpenAI product availability must be checked before deployment:

- ChatGPT Plus: custom MCP developer connection is not currently available.
- ChatGPT Pro: custom MCP is limited to read/fetch actions in developer mode.
- ChatGPT Business and Enterprise/Edu: full MCP, including write/modify actions, is available in beta under workspace administration.

Therefore the bridge may be code-complete while connection to the current ChatGPT account remains product-plan blocked. Do not replace ChatGPT with a new UI to bypass this limitation.

ChatGPT cannot connect directly to a local MCP server. A supported Secure MCP Tunnel or a reviewed remote HTTPS deployment is required. Do not expose an unauthenticated local endpoint to the public internet.

## Setup

Requirements:

- Node.js 22+;
- npm 10.9+;
- an existing local Codex login when Codex is enabled;
- Windows only for PowerShell, Windows service, and Scheduled Task operations.

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

For a supported ChatGPT plan, connect the local service through Secure MCP Tunnel or deploy behind a controlled HTTPS/OAuth boundary, then add the `/mcp` endpoint in ChatGPT developer app settings.

Production deployment must include supported authentication, TLS, an allowlisted hostname, and server-side secret storage. The bridge intentionally refuses `NODE_ENV=production` with `MCP_AUTH_MODE=none`.

## Initial safe configuration

The example registry starts with:

```text
Codex read:   allowed
Codex write:  blocked
Hermes read:  allowed
Hermes write: blocked
Write roots:  none
Scripts:      none
```

Write access is enabled only after read-only UAT passes and the ChatGPT tool approval behavior is verified on a plan that supports write tools.

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
11. The official MCP client can initialize, list tools, and call `delegation_health`.
12. Direct Hermes file writes cannot escape registered and request scopes.

## Legacy V2 boundary

`agent-workflow-platform-v2` is an aborted replacement-platform experiment. It is not the foundation of this package, and the new bridge imports none of its UI, database, queue, worker, routing model, conversation code, or host adapter runtime.

Do not deploy or resume V2. Preserve it only until the new architecture is reviewed and the old runtime is safely stopped without deleting evidence.

See `docs/ADR-003-chatgpt-primary-delegation-bridge.md`.
