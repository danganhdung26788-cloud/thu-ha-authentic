# ADR-003 — ChatGPT is the only primary brain

- **Status:** Accepted
- **Date:** 2026-08-01
- **Supersedes:** the chat-first replacement-platform direction under `agent-workflow-platform-v2`

## Context

The existing SYSTEM AI WORKFLOW is centered on ChatGPT itself. The user works in the ChatGPT project, where ChatGPT owns the conversation, context, files, connected tools, clarification, approvals, and final response.

The previous V2 direction incorrectly built a second chat UI, task database, queue, worker lifecycle, local Manager model, retry engine, and cutover path. That created a competing workflow platform instead of extending the existing ChatGPT-centered system.

## Decision

ChatGPT remains the only primary brain and the only normal user interface.

ChatGPT performs every task it can complete with its own reasoning and native/connected tools. ChatGPT calls the delegation bridge only when it intentionally needs specialist advice or a bounded local capability.

The bridge exposes explicit MCP tools. There is no backend Manager Agent and no automatic target selection inside the bridge.

```text
ChatGPT project
  ├─ direct reasoning
  ├─ native tools: web, weather, files, Gmail, Calendar, Drive, etc.
  └─ explicit MCP call only when needed
       ├─ Codex: read-only analysis/plan/diff proposal
       ├─ fixed Agents SDK specialist: answer only
       └─ bounded local executor: deterministic action, not AI

Returned result -> ChatGPT evaluates -> user
```

## Specialist AI versus execution

Specialist AI and execution are separate responsibilities:

```text
Specialist AI -> analysis, answer, implementation plan, proposed diff
ChatGPT       -> evaluates, asks for clarification/approval, owns final decision
Local executor -> performs only explicitly approved deterministic operations
```

No specialist AI tool may mutate the user workspace. A specialist may propose a unified diff as text, but it cannot apply it.

## Agents SDK boundary

Agents SDK is not treated as a transport and is not inserted as another general-purpose brain.

- When a specialist is implemented as an Agents SDK agent, the bridge runs that dedicated answer-only agent.
- When a target has an official specialist SDK, such as Codex, the bridge calls it in read-only proposal mode.
- Bounded local operations run directly under server-side workspace policy and are not represented as an AI specialist.
- The bridge never creates a triage/Manager model merely to select a target that ChatGPT has already selected.

This avoids a hidden second reasoning layer, unnecessary latency, duplicate API cost, conflicting routing decisions, and uncontrolled AI mutation.

## Explicit MCP tools

Initial tools are intentionally narrow:

- `delegation_health`
- `ask_codex`
- `inspect_local_runtime`
- `execute_local_operations`
- `ask_specialist_agent` only when an Agents SDK specialist is explicitly configured

`ask_codex` supports analysis, implementation plan, or a proposed unified diff as text. It is always read-only.

`execute_local_operations` is the only initial mutation capability. It is deterministic, separately named, separately permissioned, and requires user-facing approval plus server-side write scope.

A real Hermes AI integration, if later approved and technically available, must be introduced as a separate answer-only specialist tool that calls the actual Hermes service/model. Local file, PowerShell, Docker, or Scheduled Task operations must never borrow the Hermes name.

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

The bridge is stateless except for bounded, tool-namespaced in-memory idempotency within one process.

## Security invariants

- Target is fixed by the MCP tool name; request payload cannot switch targets.
- Owner and workspace are resolved from server configuration and allowlists, not freely granted by model input.
- Specialist AI tools cannot mutate user resources.
- Codex focus paths must remain inside registered read roots.
- Registered roots, scripts, executables, and Scheduled Task prefixes constrain local execution.
- Executables are resolved to absolute system paths; workspace path hijacking is blocked.
- Mutating local tools require ChatGPT host approval and an explicit server-side write capability.
- No silent fallback to paid models or providers.
- Secrets are never accepted as normal tool arguments and are redacted from errors and host output.
- Requests and outputs are size- and time-bounded.
- Idempotency keys are namespaced per MCP tool.
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
- direct specialist-AI mutation of the user workspace;
- misleading use of an AI name for deterministic local operations;
- Shadow/cutover to a replacement platform;
- a second source of truth.

### Independently rebuilt or used through official boundaries

- Codex through the official Codex SDK in read-only proposal mode;
- bounded local execution rebuilt inside the bridge;
- secret redaction patterns;
- scope validation;
- structured execution results;
- dedicated answer-only model-backed specialists through Agents SDK.

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
SPECIALIST_AI_MUTATION=false
CODEX_MODE=READ_ONLY_PROPOSAL
WRITE_REQUIRES_HOST_APPROVAL=true
DIRECT_CHATGPT_TOOLS_REMAIN_PRIMARY=true
LOCAL_EXECUTOR_IS_NOT_AI=true
MISLEADING_HERMES_NAMING=false
V2_RUNTIME_DEPENDENCY=false
V2_CUTOVER=false
PLAN_AND_TUNNEL_GATE_EXPLICIT=true
```
