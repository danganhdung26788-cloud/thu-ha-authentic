# Runbook — Windows runtime activation

This document covers the technical Windows runtime. The complete user-facing deployment and acceptance procedure is:

```text
docs/RUNBOOK_CHAT_FIRST_LOCAL_MANAGER.md
```

## Safety boundary

```text
INITIAL_PHASE=V1_ONLY
V1_RUNTIME_CHANGED=FALSE
V1_DELETION_ALLOWED=FALSE
MODEL_PROVIDER=ollama
OPENAI_API_KEY=EMPTY
GOOGLE_API_KEY=EMPTY
OPENAI_API_COST=0
GEMINI_API_COST=0
```

The default runtime uses a local Ollama Manager through the OpenAI-compatible provider contract. OpenAI credentials are not required unless the owner explicitly changes `MODEL_PROVIDER=openai` through a separate cost-approved change.

## Runtime components

Docker Compose:

- PostgreSQL;
- Redis;
- MinIO;
- Ollama;
- one-time Ollama model pull;
- migrations;
- API;
- worker.

Windows host components:

- Hermes adapter on TCP 3201;
- Codex adapter on TCP 3202;
- `Hermes-V2-Hermes-HostAdapter`;
- `Hermes-V2-Codex-HostAdapter`;
- `Hermes-V2-ChatApp`;
- Desktop and Start Menu **Workflow AI** shortcuts.

Product surfaces:

```text
http://127.0.0.1:3100/app    normal chat use
http://127.0.0.1:3100/admin  technical administration
```

## Prerequisites

- Windows 11;
- Node.js 22+ and npm 11+;
- Docker Desktop;
- Git;
- local Codex sign-in for the Windows user running the adapter task;
- repository updated to the merged chat-first commit;
- local disk space for containers, the model, evidence, attachments, and backups.

The host adapters bind so Docker can reach them through `host.docker.internal`. Bearer authentication, workspace registration, allowlists, and exact owner/workspace/scope authorization remain mandatory.

## One-time activation

From `agent-workflow-platform-v2`:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
.\scripts\windows\Deploy-AgentV2.ps1
```

The default deployment:

1. validates Node, npm, Git, and Docker;
2. creates random local secrets when `.env` is absent;
3. configures Ollama and `qwen3:4b` by default;
4. leaves OpenAI, Gemini, and Canva cloud secrets empty;
5. installs the exact lockfile;
6. runs type-check, tests, and build;
7. checks Codex availability;
8. starts the isolated Compose topology;
9. downloads the configured local model;
10. registers Hermes/Codex Scheduled Tasks;
11. installs hidden chat startup and shortcuts;
12. runs chat-first smoke tests;
13. runs the 100-case Vietnamese routing benchmark.

Do not use `-EnterShadow` during initial activation.

## Infrastructure-only mode

```powershell
.\scripts\windows\Deploy-AgentV2.ps1 -InfrastructureOnly
```

This mode may start the local model and infrastructure, but it intentionally skips the live routing acceptance gate. Normal UAT and Shadow remain blocked.

## Explicit benchmark bypass

`-SkipRoutingBenchmark` exists only for technical diagnosis. A deployment using it is not accepted for normal UAT or Shadow.

Do not lower benchmark thresholds to make an unsuitable model pass.

## Firewall change

Firewall modification is a separate deep-intervention gate:

```powershell
.\scripts\windows\Deploy-AgentV2.ps1 -ConfigureFirewall
```

Rules are limited to the approved local/private scope. Public exposure is not part of the default deployment.

## Workspace registry

Local file:

```text
runtime/workspaces.json
```

Every workspace binds:

- owner ID;
- workspace ID;
- root;
- read roots;
- write roots;
- executable allowlist;
- script allowlist;
- Scheduled Task prefix.

There is no fallback workspace. Unknown owner/workspace combinations are denied.

## Hermes policy

Hermes accepts only registered tools and allowlisted script files:

```text
filesystem.read
filesystem.write
powershell.execute
runtime.inspect
scheduled-task.manage
```

Inline arbitrary PowerShell is forbidden. File writes require authorized scope and target read-back. Final receipts are idempotent; retryable failures are not cached as successful final results.

## Codex policy

Codex uses the official TypeScript SDK and local Codex login.

Defaults:

```text
sandboxMode=workspace-write
approvalPolicy=never after V2 Approval Gate
networkAccessEnabled=false
webSearchMode=disabled
```

Normal Sandbox/UAT tasks cannot change credentials, permissions, billing, repository visibility, deep operating-system settings, or Git history.

## Verification

```powershell
.\scripts\windows\Test-AgentV2.ps1
.\scripts\windows\Test-LocalManagerRouting.ps1
```

Acceptance requires:

- API health and readiness;
- PostgreSQL, Redis, MinIO, and local model readiness;
- Hermes and Codex adapter health/readiness;
- chat page and signed session cookie;
- three Scheduled Tasks registered and enabled;
- Desktop and Start Menu shortcuts;
- structured routing schema 100%;
- routing accuracy at least 95%;
- critical approval recall 100%;
- clarification recall 100%;
- registered tool validity 100%.

## Normal operation

The user opens **Workflow AI** and uses `/app`. PowerShell is not the daily interface.

The launcher:

- starts Docker Desktop when required;
- starts the Compose topology and adapters;
- waits for local model readiness;
- opens `/app`;
- creates a sanitized startup diagnostic on failure.

Startup diagnostic:

```text
runtime/diagnostics/startup-latest.txt
```

## Technical administration

`/admin` remains bearer-authenticated and intended for technical inspection, advanced audit, evidence, registry, adapter health, and cutover controls. The token remains outside the normal chat interface.

## Backup and restore

Backup:

```powershell
.\scripts\windows\Backup-AgentV2.ps1
```

A complete chat-first backup includes PostgreSQL, MinIO, chat attachments, local configuration, Ollama model metadata, checksums, Git commit, and cutover phase.

Restore requires explicit owner approval:

```powershell
.\scripts\windows\Restore-AgentV2.ps1 `
  -BackupDirectory <backup-directory> `
  -ConfirmRestore `
  -Confirm
```

Restore verifies checksums, restores PostgreSQL/MinIO/chat attachments, restarts services, and runs the smoke test. Backups created before attachment coverage are incomplete for chat-first restore.

## Stop without deletion

```powershell
.\scripts\windows\Stop-AgentV2.ps1
```

This preserves data and V1. Never use `docker compose down -v` during rollback or diagnosis.

## Cutover

The sequential phases remain:

```text
V1_ONLY -> SHADOW -> DUAL_RUN -> V2_PRIMARY -> V1_DECOMMISSIONED
```

The default activation does not enter Shadow. Shadow requires separate owner approval after local deployment, live benchmark, read-only UAT, clarification/approval/diagnostic UAT, attachment tests, complete backup/restore, and reboot/resume all pass.
