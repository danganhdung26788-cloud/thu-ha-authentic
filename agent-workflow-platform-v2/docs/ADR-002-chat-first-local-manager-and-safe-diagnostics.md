# ADR-002 — Chat-first UX, local Manager model, and safe diagnostics

- **Status:** APPROVED
- **Decision date:** 2026-08-01
- **Owner:** danganhdung
- **Applies to:** `agent-workflow-platform-v2`
- **Cutover boundary:** `V1_ONLY`

## 1. Context

Workflow AI V2 already has an OpenAI Agents SDK orchestration core, policy engine, approval gate, PostgreSQL/Redis/MinIO control plane, Windows Hermes/Codex host adapters, backup/restore, audit, evidence, and cutover controls.

The current internal `/admin` page still exposes implementation details such as API token, owner, workspace, autonomy, risk, read scope, and write scope. That is acceptable for technical administration but not for normal operation.

The owner requires the normal experience to be as simple as sending one chat message. The owner must not have to open PowerShell, compose JSON, choose an executor, manage ports, locate logs, or understand Docker.

The Manager Agent still requires a model. Its primary job is bounded intent understanding, structured routing, and clarification—not deep specialist reasoning. The default model therefore does not need to be a paid high-end cloud model.

When the system fails or needs a decision, the owner may not know how to diagnose it. The product must therefore generate a self-contained, secret-redacted diagnostic block that can be copied and pasted into ChatGPT for assistance.

## 2. Decision

### 2.1 Default user experience

The default product surface will be a **chat-first application**. Normal use consists of:

1. open the Workflow AI shortcut;
2. type one natural-language request in Vietnamese;
3. optionally attach or drag files;
4. press Enter;
5. follow progress and answer only genuine business clarifications or approval prompts;
6. receive the result in the same conversation.

The default UI must not request or display:

- API tokens;
- owner ID or workspace ID;
- read/write scopes;
- autonomy or risk level;
- executor selection;
- Docker, ports, PIDs, PowerShell, JSON, or raw logs.

These controls remain available only in a separate technical administration surface.

### 2.2 Orchestration architecture

The OpenAI Agents SDK remains the orchestration core. It is not removed or replaced.

The normal flow is:

```text
Chat message / attachment
  -> conversation context resolver
  -> Manager Agent
  -> structured ManagerDecision
  -> policy + owner/workspace/scope authorization
  -> approval gate when required
  -> Hermes / Codex / NotebookLM / Canva / Specialist
  -> evidence + audit + result normalization
  -> conversation response
```

The Manager model is not trusted to grant permissions. Every route and tool call is revalidated by deterministic policy at the executor boundary.

### 2.3 Local model as the default Manager provider

The initial approved direction is a **local, zero-API-cost model** exposed through an OpenAI-compatible endpoint. Ollama is the default local runtime candidate.

Initial candidate:

```text
MODEL_PROVIDER=ollama
MODEL_BASE_URL=http://host.docker.internal:11434/v1
MANAGER_MODEL=qwen3:4b
MODEL_API_KEY=local-only-placeholder
OPENAI_API_COST=0
GEMINI_API_COST=0
```

`qwen3:4b` is a candidate, not a permanent lock. It must pass the routing acceptance suite before activation. If it fails, the next candidate is `qwen3:8b` or another locally hosted model that supports structured output and tool-call style routing.

Cloud OpenAI remains an optional future provider behind a separate owner approval and cost gate. It is not required for the first chat-first UAT.

### 2.4 Provider abstraction

The runtime must stop assuming that a string model name always resolves through the default OpenAI provider.

A provider factory will create the Agents SDK model provider from configuration. At minimum it must support:

- `ollama` or another OpenAI-compatible local endpoint;
- `openai` as an optional future provider;
- explicit startup failure when the configured provider is unavailable;
- no silent fallback to a paid provider;
- no secret logging.

### 2.5 Automatic context and scope resolution

The system derives technical context from the signed-in Windows user, registered workspace, active conversation, attachments, and policy defaults.

The Manager may propose scopes, but deterministic code must resolve and authorize them. The UI asks the user only when the business intent is ambiguous, for example:

> Sửa trực tiếp tệp gốc hay tạo một bản sao?

It must not ask technical questions such as which executor, risk level, or write scope to use.

### 2.6 Safe diagnostic copy flow

Every failed, blocked, stalled, or approval-required task must offer:

- **Tóm tắt dễ hiểu**;
- **Xem chi tiết kỹ thuật**;
- **Sao chép để hỏi ChatGPT**.

The copied diagnostic report must be self-contained and include, where available:

- timestamp and runtime version/commit;
- task ID and correlation ID;
- original objective;
- current status and failing stage;
- selected executor and route summary;
- normalized error code and human summary;
- API, worker, database, Redis, MinIO, adapter, and local model health;
- retry count and last transition;
- bounded recent logs;
- approval context when applicable;
- a direct request asking ChatGPT to analyze the cause and propose safe next steps.

The report must redact:

- API keys and bearer tokens;
- authorization and cookie headers;
- passwords and connection-string secrets;
- `.env` secret values;
- access/refresh tokens;
- private keys and credentials;
- any value tagged as secret by configuration metadata.

The report must preserve useful variable names and error structure. It must not expose thousands of log lines or require the owner to collect separate files manually.

### 2.7 Startup and daily operation

Normal operation must require no terminal commands.

The finished product will provide:

- a desktop/start-menu shortcut;
- automatic startup of required local services;
- a single application URL or desktop shell;
- automatic readiness checks;
- a human-readable recovery state;
- technical logs only behind an explicit advanced view.

PowerShell remains an internal maintenance and disaster-recovery tool, not the normal user interface.

## 3. Product surfaces

### 3.1 `/app` — default chat experience

Responsibilities:

- conversation list and current thread;
- single message composer;
- drag/drop attachment area;
- live progress timeline;
- clarification cards;
- approval cards;
- result and evidence links;
- copy-safe diagnostics.

### 3.2 `/admin` — technical operations

Responsibilities:

- runtime overview;
- task and audit inspection;
- adapter/provider health;
- cutover controls;
- registry and policy inspection;
- advanced diagnostics.

`/admin` is not the normal user entry point.

## 4. Required data and API additions

The implementation may refine names, but must cover these concepts:

### Data

- conversation sessions;
- chat messages;
- message attachments;
- task-to-conversation linkage;
- clarification requests and responses;
- user-facing progress events;
- generated diagnostic reports with redaction metadata.

### API

- create/list/read conversation;
- submit a chat message with idempotency;
- upload/register attachments;
- stream progress through SSE or an equivalent bounded mechanism;
- answer clarification;
- approve/reject guarded action;
- retrieve/copy a sanitized diagnostic report.

All APIs remain authenticated and owner/workspace scoped even when the UI hides those fields.

## 5. Security and privacy controls

- Default bind remains local/private; no public exposure is implied by this ADR.
- Local model traffic stays on the machine or approved private network.
- A model decision never bypasses policy or approval.
- Attachments are scanned, size-limited, hashed, and stored within registered scope.
- Diagnostic reports are redacted on the server before reaching the browser.
- Raw secrets are never placed in browser state, diagnostics, audit payloads, or model prompts.
- External publishing/sharing remains approval-gated.
- V1 remains unchanged and authoritative until later cutover gates pass.

## 6. Acceptance criteria

### Chat-first UX

```text
DEFAULT_ENTRYPOINT_IS_CHAT=TRUE
ONE_NATURAL_LANGUAGE_MESSAGE_CAN_CREATE_TASK=TRUE
NORMAL_USER_SEES_NO_TOKEN_OR_SCOPE_FIELDS=TRUE
DRAG_DROP_ATTACHMENTS=PASS
NO_POWERSHELL_REQUIRED_FOR_NORMAL_USE=TRUE
```

### Manager provider

```text
AGENTS_SDK_REMAINS_CORE=TRUE
LOCAL_PROVIDER_SUPPORTED=TRUE
PAID_PROVIDER_SILENT_FALLBACK=FALSE
OPENAI_API_KEY_REQUIRED_FOR_LOCAL_UAT=FALSE
STRUCTURED_MANAGER_OUTPUT=100_PERCENT_VALID
```

### Routing safety

- at least 100 Vietnamese routing scenarios;
- 100% schema-valid `ManagerDecision` output;
- zero unauthorized executor/tool grants;
- zero missed approval requirements for credentials, production, irreversible deletion, history rewrite, deep OS changes, significant cost, or external publication;
- ambiguous high-risk tasks must clarify or wait for approval instead of guessing.

### Diagnostics

```text
ERROR_UI_HAS_COPY_DIAGNOSTIC=TRUE
DIAGNOSTIC_IS_SELF_CONTAINED=TRUE
SECRET_REDACTION=PASS
DEFAULT_VIEW_IS_HUMAN_READABLE=TRUE
RAW_TECHNICAL_DETAILS_REQUIRE_EXPLICIT_EXPAND=TRUE
```

Redaction tests must include representative OpenAI-style keys, bearer headers, cookies, database URLs, MinIO secrets, adapter tokens, private key blocks, and arbitrary configured secret names.

### Runtime

- local provider health is part of `/ready`;
- startup and reboot/resume checks pass;
- failure of the local model produces a sanitized diagnostic, not a blank or generic error;
- V1 remains unchanged;
- phase remains `V1_ONLY` throughout this milestone.

## 7. Rejected alternatives

### Paid cloud Manager as the mandatory first step

Rejected for the initial milestone because routing does not require a high-end model and the owner explicitly prefers zero additional API cost.

### Pure deterministic router with no model

Rejected as the sole solution because natural-language requests can be ambiguous and multi-step. Deterministic policy remains authoritative, but a model is retained for bounded language understanding and structured routing.

### Exposing the existing admin form as the final UI

Rejected because it requires technical fields and does not meet the one-message operating requirement.

### Showing raw logs by default

Rejected because it overwhelms the user and risks leaking secrets. Raw details require explicit expansion and server-side redaction.

## 8. Consequences

Positive:

- one-message operation;
- no mandatory external AI API cost for initial UAT;
- Agents SDK investment remains central;
- safer and faster support through copyable diagnostics;
- technical complexity is hidden without weakening policy enforcement.

Costs and risks:

- local inference consumes RAM, CPU, and electricity;
- small models may misroute or emit invalid structures;
- additional conversation, attachment, progress, and diagnostic persistence is required;
- Ollama/OpenAI-compatible behavior must be verified against the pinned Agents SDK version;
- desktop startup and lifecycle require Windows-specific testing.

## 9. Rollback and phase control

This ADR does not authorize Shadow, dual-run, V2 primary, V1 deletion, public exposure, paid API activation, or firewall expansion.

During implementation and UAT:

```text
CUTOVER_PHASE=V1_ONLY
V1_RUNTIME_CHANGED=FALSE
V1_DELETION_ALLOWED=FALSE
OPENAI_API_COST=0
GEMINI_API_COST=0
```
