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
       ├─ Codex
       ├─ Hermes
       └─ Agents SDK specialist agents

Specialist result -> ChatGPT -> user
```

## Agents SDK boundary

Agents SDK is not treated as a transport and is not inserted as another general-purpose brain.

- When a specialist is implemented as an Agents SDK agent, the bridge runs that dedicated agent.
- When a target has an official specialist SDK or a bounded execution adapter, the bridge calls that target directly.
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
- Mutating tools require host approval and an explicit server-side write feature flag.
- No silent fallback to paid models or providers.
- Secrets are never accepted in tool arguments and are redacted from errors.
- Requests and outputs are size- and time-bounded.
- Direct questions such as weather, current news, email, calendar, or file search stay with ChatGPT native tools.

## Consequences

### Removed from the new design

- `/app` and any replacement chat UI;
- local Manager/router model;
- V2 conversation tables;
- V2 task database and BullMQ lifecycle;
- V2 progress/retry/diagnostic UI;
- Shadow/cutover to a replacement platform;
- a second source of truth.

### Potentially reusable only behind clean boundaries

- Codex and Hermes execution adapters;
- secret redaction patterns;
- bounded scope validation;
- structured execution results.

The new bridge must not import V2 application, database, queue, or UI modules.

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
V2_CUTOVER=false
```
