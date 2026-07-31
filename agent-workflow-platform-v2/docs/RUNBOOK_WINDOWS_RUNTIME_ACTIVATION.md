# Runbook — Windows Runtime Activation

## Status boundary

This runbook deploys Workflow AI V2 in parallel. It does not stop, modify or delete V1.

```text
INITIAL_PHASE=V1_ONLY
GEMINI_RUNTIME=DISABLED
GOOGLE_API_KEY=EMPTY
V1_DELETION_ALLOWED=FALSE
```

## Components

- Docker Desktop: PostgreSQL, Redis, MinIO, API and worker.
- Windows host adapter 3201: Hermes bounded executor.
- Windows host adapter 3202: Codex SDK executor.
- Scheduled Tasks:
  - `Hermes-V2-Hermes-HostAdapter`
  - `Hermes-V2-Codex-HostAdapter`
- Secrets and workspace registry are local files ignored by Git.

## Prerequisites

- Windows 11.
- Node.js 22+ and npm 11+.
- Docker Desktop engine running.
- Git installed.
- Codex signed in on the Windows user that runs the Scheduled Task.
- The repository checked out locally on `main` after PR merge.

The host adapters use `0.0.0.0` so Docker can reach them through `host.docker.internal`. Bearer authentication, owner/workspace checks and the Windows Firewall gate remain mandatory.

## One-command deployment

Run in an elevated PowerShell only when approving the firewall change:

```powershell
Set-Location <repository>\agent-workflow-platform-v2
.\scripts\windows\Deploy-AgentV2.ps1 -ConfigureFirewall
```

Without a firewall change:

```powershell
.\scripts\windows\Deploy-AgentV2.ps1
```

The deployment script:

1. verifies Node, npm, Git and Docker;
2. creates random local secrets when `.env` is absent;
3. keeps Gemini and Canva API settings empty;
4. installs the exact lockfile;
5. runs type-check, tests and build;
6. checks Codex CLI availability;
7. starts the isolated Docker topology;
8. registers hidden host-adapter Scheduled Tasks;
9. runs health/readiness smoke tests.

It does not automatically enter Shadow unless `-EnterShadow` is supplied.

## Workspace registry

Local file:

```text
runtime/workspaces.json
```

Every entry binds:

- owner ID;
- workspace ID;
- workspace root;
- read roots;
- write roots;
- executable allowlist;
- script allowlist;
- Scheduled Task prefix.

No fallback workspace exists. An unregistered owner/workspace is denied.

## Hermes execution policy

Hermes does not accept arbitrary inline shell.

Allowed tool calls:

- `filesystem.read`
- `filesystem.write`
- `powershell.execute` for allowlisted script files only
- `runtime.inspect`
- `scheduled-task.manage` using the `Hermes-V2-` prefix

Every file operation is checked against both the persistent workspace registry and the task `READ_SCOPE`/`WRITE_SCOPE`. Writes use target read-back. Host results are stored as idempotent receipts by owner/workspace/task.

## Codex execution policy

Codex uses the official TypeScript SDK and the local Codex login.

Defaults:

```text
sandboxMode=workspace-write
approvalPolicy=never
networkAccessEnabled=false
webSearchMode=disabled
```

The V2 policy and Approval Gate run before Codex receives a task. Codex is not permitted to change credentials, permissions, billing, repository visibility, operating-system settings or Git history through a normal Sandbox/UAT task.

## Verification

```powershell
.\scripts\windows\Test-AgentV2.ps1
```

Acceptance:

- API `/health` PASS;
- API `/ready` PASS;
- PostgreSQL, Redis and MinIO PASS;
- Hermes adapter health/readiness PASS;
- Codex adapter health/readiness PASS;
- both Scheduled Tasks registered and enabled.

## Backup

```powershell
.\scripts\windows\Backup-AgentV2.ps1
```

Artifacts:

- PostgreSQL custom-format dump;
- MinIO data archive;
- local configuration copies;
- SHA-256 manifest;
- Git commit reference.

## Restore

Restore is a deep intervention and requires explicit confirmation:

```powershell
.\scripts\windows\Restore-AgentV2.ps1 `
  -BackupDirectory <backup-directory> `
  -ConfirmRestore `
  -Confirm
```

The script verifies every checksum, stops API/worker, restores PostgreSQL and MinIO, restarts services and runs the smoke test.

## Shadow activation

After deployment and backup PASS:

```powershell
.\scripts\windows\Start-AgentV2Shadow.ps1
```

Shadow rules:

- V1 remains authoritative.
- V2 cannot write to V1.
- Compare normalized outputs and evidence.
- Record mismatches before dual-run.

## Cutover controls

Use `Set-AgentV2Phase.ps1`. The server enforces sequential phases:

```text
V1_ONLY -> SHADOW -> DUAL_RUN -> V2_PRIMARY -> V1_DECOMMISSIONED
```

`V2_PRIMARY` requires verified backup, owner approval and a future rollback deadline.

`V1_DECOMMISSIONED` requires:

- 7/7 soak PASS;
- expired rollback window;
- verified backup;
- owner approval.

## Stop without deletion

```powershell
.\scripts\windows\Stop-AgentV2.ps1
```

This stops host adapters and Docker containers but preserves volumes and V1.

## Rollback

During Shadow or dual-run:

1. transition V2 back one allowed phase;
2. run `Stop-AgentV2.ps1` if needed;
3. keep V1 active;
4. preserve V2 logs, receipts, audit and evidence for analysis.

Never use `docker compose down -v` during rollback.
