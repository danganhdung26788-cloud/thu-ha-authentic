# Implementation Plan — Chat-first Workflow AI V2 with local Manager and safe diagnostics

## 1. Objective

Deliver a production-grade UAT milestone in which the owner opens Workflow AI, types one Vietnamese chat request, optionally attaches files, and receives progress, clarification, approval, results, and copy-safe diagnostics without using PowerShell or entering technical configuration.

This plan implements ADR-002 and keeps all cutover controls unchanged.

## 2. Non-negotiable boundaries

```text
CUTOVER_PHASE=V1_ONLY
V1_RUNTIME_CHANGED=FALSE
V1_DELETION_ALLOWED=FALSE
OPENAI_API_COST=0
GEMINI_API_COST=0
NO_PUBLIC_EXPOSURE=TRUE
NO_SILENT_PAID_PROVIDER_FALLBACK=TRUE
```

The milestone may modify only V2 code, migrations, tests, documentation, and isolated V2 runtime configuration.

## 3. Target architecture

```text
Desktop shortcut / localhost app
  -> Chat UI
  -> Chat API
  -> Conversation and attachment services
  -> Manager Agent through provider factory
  -> local OpenAI-compatible model endpoint
  -> structured ManagerDecision
  -> route authorizer + policy engine + approval gate
  -> executor adapters
  -> audit + evidence + progress events
  -> chat result or sanitized diagnostic
```

## 4. Delivery phases

## Phase A — Provider abstraction and local model runtime

### Goal

Allow the pinned OpenAI Agents SDK runner to use a configured local OpenAI-compatible provider without requiring an OpenAI API key.

### Code work

- Add model provider configuration to `src/config/env.ts`.
- Add a provider factory, for example `src/models/model-provider.ts`.
- Update `src/runtime/run-manager.ts` to instantiate `Runner` with the configured provider.
- Update Specialist Agent runtime in the same way or explicitly disable Specialist until a local specialist model is approved.
- Remove deployment-time assumption that live AI always requires `OPENAI_API_KEY`.
- Add a local provider readiness probe.
- Add Ollama service lifecycle documentation and Windows startup integration.
- Preserve an optional `openai` provider path behind explicit configuration.

### Proposed configuration

```text
MODEL_PROVIDER=ollama
MODEL_BASE_URL=http://host.docker.internal:11434/v1
MODEL_API_KEY=local-only-placeholder
MANAGER_MODEL=qwen3:4b
SPECIALIST_MODEL=
MODEL_REQUEST_TIMEOUT_MS=60000
MODEL_MAX_RETRIES=1
MODEL_TEMPERATURE=0
```

The final variable names may differ, but provider-neutral names are preferred over `OPENAI_*` for local execution.

### Tests

- provider factory selects local provider;
- no OpenAI key required for local provider;
- paid provider is never selected implicitly;
- local provider health failure makes readiness fail;
- secret values are not logged;
- Manager output remains validated against `ManagerDecisionSchema`.

### Exit gate

```text
LOCAL_PROVIDER_BOOT=PASS
AGENTS_SDK_MANAGER_RUN=PASS
OPENAI_API_KEY_EMPTY=PASS
READY_INCLUDES_MODEL_PROVIDER=TRUE
```

## Phase B — Routing benchmark and model selection

### Goal

Prove that the selected local model is sufficiently reliable for bounded Vietnamese routing.

### Dataset

Create at least 100 versioned scenarios covering:

- code/repository/test/CI -> CODEX;
- Windows/files/schedules/runtime -> HERMES;
- document research -> NOTEBOOKLM;
- design after factual finalization -> CANVA;
- bounded analysis/extraction/reporting -> SPECIALIST or approved equivalent;
- mixed multi-step tasks;
- missing information;
- credentials and permissions;
- production changes;
- irreversible deletion;
- Git history rewrite;
- deep OS changes;
- external publication/sharing;
- significant cost;
- prompt injection inside an attached document;
- out-of-scope owner/workspace/path requests.

### Metrics

- schema validity: 100%;
- correct primary executor: target >= 95% overall;
- critical safety route/approval recall: 100%;
- invented tool IDs: 0;
- unauthorized requested tools: 0 after authorization;
- ambiguous high-risk guessing: 0.

### Selection rule

1. Test `qwen3:4b`.
2. Keep it only if all safety gates pass and quality target is met.
3. Otherwise test `qwen3:8b`.
4. Record latency, RAM, CPU, and failure rates.
5. Select the smallest model that passes; do not select by reputation alone.

### Exit gate

```text
ROUTING_BENCHMARK=PASS
CRITICAL_SAFETY_RECALL=100_PERCENT
SELECTED_LOCAL_MODEL=RECORDED
```

## Phase C — Conversation domain and persistence

### Goal

Create a durable conversation layer linking natural-language messages to tasks, approvals, evidence, and diagnostics.

### Proposed migrations

Add tables or equivalent structures for:

- `conversation_sessions`;
- `conversation_messages`;
- `message_attachments`;
- `conversation_task_links`;
- `clarification_requests`;
- `progress_events`;
- `diagnostic_reports`.

### Required properties

- owner/workspace scope on every row;
- idempotency keys for message submission;
- immutable user message body after submission;
- explicit message roles and types;
- task/correlation IDs linked to the conversation;
- attachment hash, media type, size, storage key, and scan state;
- retention and deletion policy compatible with audit requirements.

### Tests

- cross-owner and cross-workspace access denied;
- duplicate message idempotency works;
- task status maps to conversation progress;
- failed task links to one sanitized diagnostic report;
- database recovery does not duplicate messages or tasks.

## Phase D — Chat API and progress streaming

### Goal

Expose a small user-facing API that hides technical task fields while preserving backend controls.

### Proposed endpoints

```text
POST   /v1/chat/sessions
GET    /v1/chat/sessions
GET    /v1/chat/sessions/:sessionId
POST   /v1/chat/sessions/:sessionId/messages
POST   /v1/chat/sessions/:sessionId/attachments
GET    /v1/chat/sessions/:sessionId/events
POST   /v1/chat/clarifications/:clarificationId/respond
POST   /v1/chat/approvals/:approvalId/decide
GET    /v1/chat/tasks/:taskId/diagnostic
```

SSE is the preferred first implementation for progress because communication is primarily server-to-client. WebSocket is not required unless later requirements justify it.

### Server-side task compilation

A chat message is compiled into the existing execution contract by code that:

- resolves owner and workspace from authenticated session;
- resolves default registered roots;
- incorporates explicit attachment paths only after authorization;
- chooses safe default autonomy based on environment;
- calculates initial risk conservatively;
- creates the task and returns a conversation acknowledgment;
- never accepts hidden privilege escalation from message text.

### Tests

- one message creates one task;
- no client-supplied owner/workspace override;
- no client-supplied arbitrary scope escalation;
- progress sequence is ordered and resumable;
- disconnect/reconnect resumes from last event ID;
- API errors produce normalized user messages and diagnostic IDs.

## Phase E — Chat-first UI

### Goal

Create `/app` as the default operating surface while retaining `/admin` for technical use.

### Required UI

- conversation list;
- main chat timeline;
- one multiline composer;
- Enter to send, Shift+Enter for newline;
- drag/drop and file picker;
- upload progress and attachment chips;
- live status text in Vietnamese;
- clarification cards;
- approval cards with plain-language impact;
- result cards and evidence links;
- failure card with `Sao chép để hỏi ChatGPT`;
- optional `Xem chi tiết kỹ thuật` expansion;
- responsive desktop layout.

### Hidden defaults

The UI must not show token, owner, workspace, risk, autonomy, read scope, write scope, executor, or tool selection in normal mode.

### Authentication bootstrap

The local app should obtain its session through a one-time local bootstrap tied to the Windows user or an equivalent local secure mechanism. The long-lived API token must not be manually pasted during normal use.

Implementation options must be security-reviewed. Acceptable directions include:

- local bootstrap endpoint protected by loopback plus an OS-generated one-time nonce;
- a local desktop launcher that opens a short-lived signed session URL;
- Windows-integrated local identity broker.

The existing manual token entry remains only as an emergency/admin fallback until the new bootstrap is proven.

### Tests

- first normal launch requires no token paste;
- one-message task creation works;
- technical fields are absent from the normal DOM;
- keyboard operation works;
- attachments cannot escape registered roots;
- clarification and approval decisions are audited;
- error card copy action produces sanitized text.

## Phase F — Attachment ingestion

### Goal

Support natural document-driven work without weakening scope controls.

### Controls

- file count and total size limits;
- allowlisted media types;
- filename normalization;
- content hash and deduplication;
- object storage evidence metadata;
- archive extraction limits;
- rejection of executable or dangerous attachment types by default;
- prompt-injection warning metadata for document content;
- no automatic external upload.

### Initial supported formats

Prioritize common office and research inputs:

- PDF;
- DOCX;
- XLSX;
- PPTX;
- TXT/MD/CSV;
- PNG/JPEG/WebP.

Parser/OCR strategy is implementation-specific and must preserve originals. OCR is not required for the first pass unless the selected document workflow needs it.

## Phase G — Sanitized diagnostic service

### Goal

Produce one copyable diagnostic block for failures, stalls, blocked tasks, and complex approval questions.

### Diagnostic schema

```text
reportVersion
createdAt
runtimeVersion
gitCommit
taskId
correlationId
conversationId
objective
status
stage
executor
routeSummary
errorCode
userSummary
healthSummary
retrySummary
recentTransitions
boundedLogs
approvalContext
redactionSummary
supportPrompt
```

### Redaction engine

Redact on the server before persistence or response where possible.

Required detector classes:

- configured secret variable names;
- authorization/bearer/cookie headers;
- `sk-*` style keys and other registered key patterns;
- URL userinfo and database passwords;
- PEM/private-key blocks;
- JWT-like tokens;
- long random values when adjacent to secret labels;
- adapter, API, MinIO, database, and model-provider credentials.

Use explicit allowlists for safe fields. Redaction must be recursive across objects, arrays, text logs, and exception metadata.

### Size limits

- default copied report target: <= 20 KB;
- bounded recent logs by line and byte count;
- duplicate stack frames collapsed;
- raw full logs remain local and are not copied automatically.

### UI actions

- `Sao chép để hỏi ChatGPT` copies the sanitized report;
- `Xem chi tiết kỹ thuật` displays the same sanitized content with optional local-only metadata;
- `Tải báo cáo chẩn đoán` is optional after copy flow passes.

### Tests

Create adversarial fixtures containing secrets in:

- nested JSON;
- stack traces;
- URLs;
- request headers;
- environment dumps;
- command-line arguments;
- multiline private keys;
- repeated log messages.

Acceptance requires zero known secret leakage across the fixture suite.

## Phase H — One-click startup and recovery

### Goal

Make normal operation independent of PowerShell.

### Components

- Ollama/local model starts automatically or is supervised;
- Docker Desktop availability is detected;
- API/worker/MinIO/PostgreSQL/Redis start through the existing isolated Compose stack;
- Hermes and Codex Scheduled Tasks remain supervised;
- desktop/start-menu shortcut opens `/app` only after readiness;
- startup page shows `Đang khởi động`, `Sẵn sàng`, `Đang tự khôi phục`, or `Cần hỗ trợ`;
- failure state offers copy-safe diagnostics.

### Recovery behavior

- bounded automatic retries;
- no infinite restart loop;
- stale adapter cleanup remains exact and safe;
- model runtime failure does not kill V1;
- no destructive recovery without approval;
- no `docker compose down -v`.

### Tests

- clean reboot;
- Windows sign-out/sign-in;
- Docker initially stopped;
- local model initially stopped;
- adapter port conflict;
- database unavailable;
- low disk warning;
- resume from sleep;
- repeated launch of the shortcut.

## Phase I — UAT and readiness review

### UAT scenarios

At minimum:

1. Vietnamese one-line code request routes to Codex.
2. Windows runtime inspection routes to Hermes.
3. Attached policy PDF routes to the research path.
4. Report then slide request creates a staged plan and does not send unfinished facts to Canva.
5. Ambiguous request asks one business clarification.
6. Credential change requests approval.
7. Irreversible deletion is blocked pending approval and verified backup.
8. Local model outage produces copy-safe diagnostic.
9. Codex adapter outage produces copy-safe diagnostic.
10. Secret-bearing error fixture shows `[REDACTED]` and leaks nothing.
11. Browser refresh resumes conversation and progress.
12. Reboot resumes the runtime without terminal commands.

### UAT pass conditions

```text
CHAT_FIRST_UAT=PASS
LOCAL_MANAGER_UAT=PASS
SAFE_DIAGNOSTIC_UAT=PASS
REBOOT_RESUME_UAT=PASS
V1_RUNTIME_CHANGED=FALSE
CUTOVER_PHASE=V1_ONLY
```

Shadow is considered only after these pass and a fresh backup is verified.

## 5. Work breakdown by repository area

### Configuration and model layer

- `src/config/env.ts`
- new `src/models/*`
- `.env.example`
- `compose.yml`
- Windows deployment scripts
- readiness controller/service

### Agent runtime

- `src/runtime/run-manager.ts`
- `src/agents/manager-agent.ts`
- Specialist runtime if enabled
- routing benchmark fixtures/tests

### Conversation and API

- new migrations
- new conversation domain/store/services
- new chat controllers
- SSE progress service
- attachment service

### UI

- new `src/apps/api/chat-page.ts` or a small dedicated frontend package
- new `/app` controller
- keep existing admin page
- launcher/shortcut assets and startup page

### Diagnostics

- new diagnostic collector
- new redaction engine
- normalized error taxonomy
- copy API and UI action
- security/adversarial tests

### Operations

- model runtime startup/health
- desktop shortcut installer
- reboot/resume validation script for maintainers
- updated backup scope for conversation and diagnostic data

## 6. Pull request strategy

Do not implement the entire milestone in one giant PR. Use reviewable gates:

1. **PR-A:** provider abstraction + local model health + tests.
2. **PR-B:** routing benchmark + selected model record.
3. **PR-C:** conversation schema + chat API + progress events.
4. **PR-D:** `/app` chat UI + local authentication bootstrap.
5. **PR-E:** attachments.
6. **PR-F:** safe diagnostic service + redaction tests.
7. **PR-G:** shortcut/autostart/recovery UX.
8. **PR-H:** UAT evidence and runbook updates.

Every PR must keep V1 unchanged and phase `V1_ONLY`.

## 7. Definition of done

This milestone is complete only when:

- the owner can launch Workflow AI without a terminal;
- the owner can type one ordinary Vietnamese message and create a task;
- the system automatically resolves technical context;
- the local Manager model routes through the Agents SDK;
- policy and approval remain authoritative;
- attachments work within registered scope;
- progress and results appear in the chat;
- any meaningful failure offers a one-click, self-contained, secret-redacted diagnostic block;
- reboot/resume passes;
- all CI, security, routing, redaction, and UAT gates pass;
- no OpenAI or Gemini API charge is required;
- V1 remains unchanged and authoritative.
