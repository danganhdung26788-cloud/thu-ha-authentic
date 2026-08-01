# Workflow AI V2

Workflow AI V2 is a local-first, chat-first orchestration platform. The normal user opens **Workflow AI**, types one Vietnamese request, optionally attaches files, and receives progress, clarification, approval prompts, results, or a copy-safe diagnostic in the same conversation.

## Current safety boundary

```text
CUTOVER_PHASE=V1_ONLY
V1_RUNTIME_CHANGED=FALSE
V1_DELETION_ALLOWED=FALSE
OPENAI_API_COST=0
GEMINI_API_COST=0
PUBLIC_EXPOSURE=FALSE
PAID_PROVIDER_SILENT_FALLBACK=FALSE
```

V2 remains isolated from V1. It does not share V1 task state, queue leases, runtime directories, object buckets, secrets, or write paths.

## Daily use

After the one-time deployment, normal operation requires no PowerShell or technical configuration.

1. Open the **Workflow AI** shortcut on the Desktop or Start Menu.
2. Type one request, for example:

   > Kiểm tra dự án, sửa các lỗi an toàn và báo cáo kết quả.

3. Press Enter.
4. Answer only genuine business clarification or approval prompts.
5. Receive the result in the same conversation.

Default application:

```text
http://127.0.0.1:3100/app
```

Technical administration remains separate:

```text
http://127.0.0.1:3100/admin
```

The chat interface does not request API tokens, owner/workspace IDs, scopes, risk levels, executors, Docker commands, ports, PIDs, PowerShell, or JSON.

## Architecture

```text
Chat message / attachments
  -> signed local chat session
  -> deterministic context and scope compiler
  -> local Manager model
  -> OpenAI Agents SDK structured routing
  -> policy + owner/workspace/scope authorization
  -> approval gate when required
  -> Hermes / Codex / NotebookLM / Canva / Specialist
  -> evidence + audit + normalized result
  -> conversation response
```

Core components:

- Node.js 22+ and strict TypeScript.
- OpenAI Agents SDK pinned to `0.13.5` as the orchestration core.
- Local Ollama Manager/Specialist through an OpenAI-compatible provider.
- Default model candidate: `qwen3:4b`.
- Official Codex TypeScript SDK through the local Codex login.
- Hermes bounded Windows host adapter.
- PostgreSQL source of truth for tasks and conversations.
- Redis/BullMQ for queueing, leases, retries, and stalled-job recovery.
- MinIO for evidence objects with SHA-256 metadata.
- Docker Compose for the isolated control plane and local model.
- Windows Scheduled Tasks for hidden Hermes, Codex, and chat startup.

The model never grants permissions. Every route, scope, tool, and protected action is revalidated by deterministic code before execution.

## Specialized routing

```text
Local Manager       -> bounded intent understanding and structured route
Local Specialist    -> bounded extraction, classification, and reporting
Codex                -> code, repository, tests, CI, deploy, bounded rollback
Hermes               -> allowlisted files, scripts, schedules, monitoring, recovery
NotebookLM           -> closed-source research package and result handoff
Canva                -> approved design draft, template autofill, and export
Claude Review        -> independent review when separately configured
Gemini               -> disabled until separately approved
```

## Local model configuration

Default zero-API-cost configuration:

```text
MODEL_PROVIDER=ollama
MODEL_BASE_URL=http://ollama:11434/v1
MODEL_API_KEY=ollama-local
MANAGER_MODEL=qwen3:4b
SPECIALIST_MODEL=qwen3:4b
MODEL_USE_RESPONSES=false
OPENAI_API_KEY=
GOOGLE_API_KEY=
```

The placeholder local key is only required by the OpenAI-compatible client contract; it is not an external credential. There is no automatic fallback to OpenAI or another paid provider.

A future cloud provider requires an explicit configuration change, owner approval, and cost gate.

## Chat-first behavior

The server derives technical context from the signed local identity, registered workspace, active conversation, attachments, and policy defaults.

The system may ask a genuine business question:

> Anh muốn sửa trực tiếp tệp gốc hay tạo một bản sao?

It must not ask the user to choose an executor, risk level, autonomy mode, read/write scope, port, Docker setting, or API token.

Protected operations appear as simple approval cards:

```text
This task will modify protected resources.
[Approve] [Reject] [Copy to ask ChatGPT]
```

Production changes, credentials, permissions, irreversible deletion, Git history rewriting, significant cost, deep operating-system changes, and external publication remain approval-gated.

## Attachments

Supported initial file types:

```text
PDF, DOCX, XLSX, PPTX
TXT, MD, CSV, JSON, XML, YAML
PNG, JPEG, WebP
HTML, JS, TS, TSX, JSX, CSS, SQL
```

Controls:

- maximum 20 files per message;
- default maximum 25 MiB per file;
- path normalization and scope binding;
- SHA-256 metadata;
- base64 validation;
- file signature validation for PDF, images, and Open XML documents;
- generic archive uploads are not accepted;
- attachment storage is included in backup and restore.

## Safe diagnostics

Failed, blocked, stalled, clarification-required, and approval-required tasks provide:

- a human-readable summary;
- bounded technical details;
- **Sao chép để hỏi ChatGPT**.

The copied report contains task/correlation IDs, stage, executor, normalized error code, component health, retry state, recent audit, runtime commit, and a direct support request.

The server redacts API keys, bearer tokens, cookies, passwords, connection-string credentials, JWTs, private keys, and configured secret fields before data reaches the browser. Reports are size-bounded and UTF-8 safe.

## Windows runtime

Authenticated host adapters:

```text
Hermes adapter -> TCP 3201
Codex adapter  -> TCP 3202
```

Scheduled Tasks:

```text
Hermes-V2-Hermes-HostAdapter
Hermes-V2-Codex-HostAdapter
Hermes-V2-ChatApp
```

The chat launcher starts Docker Desktop when needed, starts the isolated Compose topology and adapters, waits for readiness including the local model, then opens `/app`. Startup failure produces a sanitized diagnostic file instead of requiring manual log collection.

## One-time deployment

From `agent-workflow-platform-v2` in Windows PowerShell 5.1 or newer:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
.\scripts\windows\Deploy-AgentV2.ps1
```

The deployment:

1. creates local random secrets when needed;
2. configures the local Ollama provider;
3. installs the exact lockfile;
4. runs type-check, unit/integration tests, and build;
5. starts PostgreSQL, Redis, MinIO, Ollama, API, and worker;
6. downloads the configured local model once;
7. registers hidden Hermes/Codex adapters;
8. creates Desktop and Start Menu shortcuts;
9. registers hidden logon startup;
10. runs smoke tests;
11. runs the live 100-case Vietnamese Manager benchmark.

The initial model download requires local disk space and may take time. It incurs no external model API charge.

## Routing acceptance gate

Full activation runs:

```powershell
.\scripts\windows\Test-LocalManagerRouting.ps1
```

Required results:

```text
Structured output schema: 100%
Routing accuracy: >=95%
Critical approval recall: 100%
Clarification recall: 100%
Registered tool validity: 100%
```

A failed benchmark blocks normal UAT and Shadow. The model candidate must be changed or routing instructions improved; the gate must not be bypassed merely to continue deployment.

## Validation

Repository validation:

```bash
npm ci
npm run check
npm run migrate
npm test
npm run build
npm audit --omit=dev --audit-level=high
```

CI validates migrations, secret scanning, TypeScript, unit/integration tests, Compose topology, runtime image, production dependencies, all PowerShell scripts, Windows PowerShell 5.1 compatibility, and the Windows host runtime build.

CI proves the codebase, not the user's live Windows machine. Local model quality, shortcut operation, reboot/resume, backup/restore, and a real read-only task remain runtime acceptance gates.

## Backup and restore

Backup:

```powershell
.\scripts\windows\Backup-AgentV2.ps1
```

A consistent backup contains:

- PostgreSQL custom-format dump;
- MinIO evidence archive;
- chat attachment archive;
- local configuration copies;
- Ollama model metadata;
- SHA-256 manifest;
- Git commit and cutover phase.

Restore is a deep intervention and requires explicit owner confirmation:

```powershell
.\scripts\windows\Restore-AgentV2.ps1 `
  -BackupDirectory <backup-directory> `
  -ConfirmRestore `
  -Confirm
```

Legacy backups created before chat attachment support are not sufficient for a complete chat-first restore.

## Migration phases

```text
V1_ONLY -> SHADOW -> DUAL_RUN -> V2_PRIMARY -> V1_DECOMMISSIONED
```

No phase may be skipped. This implementation does not enter Shadow automatically. V1 remains authoritative and available for rollback until all runtime, comparison, approval, rollback-window, and 7/7 soak requirements pass.

## Runtime acceptance still required after merge

1. Pull the merged commit on the Windows machine.
2. Run the one-time deployment.
3. Verify chat-first smoke test.
4. Pass the live 100-case local Manager benchmark.
5. Run one bounded `READ_ONLY` chat task.
6. Verify clarification and approval cards.
7. Force a controlled failure and verify copy-safe diagnostics.
8. Create and verify a new complete backup.
9. Perform an approved restore test in the isolated V2 environment.
10. Reboot and verify automatic recovery without PowerShell.
11. Keep `CUTOVER_PHASE=V1_ONLY` until separate Shadow approval.

See `docs/RUNBOOK_CHAT_FIRST_LOCAL_MANAGER.md` for the operational procedure.
