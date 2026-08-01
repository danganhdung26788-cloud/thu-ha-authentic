# ADR-003 — ChatGPT is the only primary brain

- **Status:** Accepted
- **Date:** 2026-08-01
- **Supersedes:** the chat-first replacement-platform direction under `agent-workflow-platform-v2`

## Context

The existing SYSTEM AI WORKFLOW is centered on ChatGPT itself. The user works in the ChatGPT project, where ChatGPT owns the conversation, context, files, connected tools, clarification, approvals, and final response.

The previous V2 direction incorrectly built a second chat UI, task database, queue, worker lifecycle, local Manager model, retry engine, and cutover path. That created a competing workflow platform instead of extending the existing ChatGPT-centered system.

## Decision

ChatGPT remains the only primary brain and the only normal user interface.

ChatGPT performs every task it can complete with its own reasoning and native/connected tools. ChatGPT calls the delegation bridge only when it intentionally needs a specialist AI or bounded external executor.

The bridge exposes explicit MCP tools. There is no backend Manager Agent and no automatic target selection inside the bridge.

```text
ChatGPT project
  ├─ direct reasoning
  ├─ native tools: web, weather, files, Gmail, Calendar, Drive, etc.
  └─ explicit specialist delegation through MCP
       ├─ Codex SDK
       ├─ bounded direct host execution
       └─ Agents SDK specialist agents

Specialist result -> ChatGPT evaluates -> user
```

## Agents SDK boundary

Agents SDK is not treated as a transport and is not inserted as another general-purpose brain.

- When a specialist is implemented as an Agents SDK agent, the bridge runs that dedicated agent.
- When a target has an official specialist SDK, the bridge calls that target directly.
- Bounded host operations run directly under server-side workspace policy; they do not require a second adapter service.
- The bridge never creates a triage/Manager model merely to select a target that ChatGPT has already selected.

This avoids a hidden second reasoning layer, unnecessary latency, duplicate API cost, and conflicting routing decisions.

## Explicit MCP tools

Initial tools are intentionally narrow:

- `delegation_health`
- `ask_codex`
- `execute_codex`
- `inspect_with_hermes`
- `execute_with_hermes`
- `ask_specialist_agent` only when an Agents SDK specialist is explicitly configured

Read-only and mutating tools are separate so ChatGPT can apply the correct approval behavior before a call.

## Ownership

The bridge does **not** own:

- conversation history;
- user-facing task state;
- a business database;
- a general job queue;
- a separate chat interface;
- follow-up interpretation;
- retries across user turns;
- cutover from the ChatGPT project.

The bridge is stateless except for bounded in-flight idempotency within one process.

## Security invariants

- Target is fixed by the MCP tool name; request payload cannot switch targets.
- Owner and workspace are resolved from server configuration and allowlists, not freely granted by model input.
- Registered roots, scripts, executables, and Scheduled Task prefixes constrain host execution.
- Mutating tools require ChatGPT host approval and an explicit server-side write capability.
- No silent fallback to paid models or providers.
- Secrets are never accepted as normal tool arguments and are redacted from errors and host output.
- Requests and outputs are size- and time-bounded.
- Direct questions such as weather, current news, email, calendar, or file search stay with ChatGPT native tools.
- The bridge has no runtime dependency on `agent-workflow-platform-v2`.

## Product availability gate

Code completion does not imply that the bridge can be connected to every ChatGPT plan.

As of the decision date:

- ChatGPT Plus does not provide the custom MCP developer connection required by this design.
- ChatGPT Pro supports custom MCP read/fetch use in developer mode, but not full write/modify MCP.
- ChatGPT Business and Enterprise/Edu provide full MCP, including write/modify actions, in beta under workspace administration.
- ChatGPT cannot connect directly to a local MCP endpoint; a supported Secure MCP Tunnel or reviewed remote HTTPS deployment is required.

The architecture must not be distorted by building another UI merely to bypass a product-plan limitation. Deployment remains blocked until the ChatGPT account and connection mechanism support the required tool permissions.

## Consequences

### Removed from the new design

- `/app` and any replacement chat UI;
- local Manager/router model;
- V2 conversation tables;
- V2 task database and BullMQ lifecycle;
- V2 progress/retry/diagnostic UI;
- V2 host-adapter runtime dependency;
- Shadow/cutover to a replacement platform;
- a second source of truth.

### Independently rebuilt or reused through official boundaries

- Codex through the official Codex SDK;
- bounded host execution rebuilt inside the bridge;
- secret redaction patterns;
- scope validation;
- structured execution results;
- dedicated model-backed specialists through Agents SDK.

The new bridge must not import V2 application, database, queue, worker, routing, conversation, UI, or adapter modules.

## Acceptance criteria

```text
CHATGPT_IS_PRIMARY_BRAIN=true
CHATGPT_IS_ONLY_NORMAL_UI=true
BACKEND_MANAGER_AGENT=false
AUTOMATIC_BACKEND_ROUTING=false
NEW_CHAT_UI=false
NEW_BUSINESS_DATABASE=false
NEW_BUSINESS_QUEUE=false
TARGET_SELECTED_BY_MCP_TOOL_NAME=true
WRITE_REQUIRES_HOST_APPROVAL=true
DIRECT_CHATGPT_TOOLS_REMAIN_PRIMARY=true
V2_RUNTIME_DEPENDENCY=false
V2_CUTOVER=false
PLAN_AND_TUNNEL_GATE_EXPLICIT=true
```
