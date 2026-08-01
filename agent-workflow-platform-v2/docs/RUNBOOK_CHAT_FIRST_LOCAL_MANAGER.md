# Runbook — Chat-first local Manager activation

## 1. Purpose

This runbook activates Workflow AI V2 as a local chat application with:

- one-message Vietnamese input;
- OpenAI Agents SDK orchestration;
- local Ollama Manager/Specialist;
- no required OpenAI or Gemini API key;
- Desktop and Start Menu shortcuts;
- hidden logon startup;
- progress, clarification, approval, result, and copy-safe diagnostics;
- V1 unchanged and authoritative.

## 2. Safety boundary

```text
CUTOVER_PHASE=V1_ONLY
V1_RUNTIME_CHANGED=FALSE
V1_DELETION_ALLOWED=FALSE
OPENAI_API_COST=0
GEMINI_API_COST=0
PUBLIC_EXPOSURE=FALSE
PAID_PROVIDER_SILENT_FALLBACK=FALSE
```

Do not add `-EnterShadow` during initial deployment. Do not open ports publicly. Do not delete Docker volumes. Do not paste secrets into chat or GitHub.

## 3. Prerequisites

- Windows 11.
- Docker Desktop running or installed so the launcher can start it.
- Node.js 22+ and npm 11+.
- Git installed.
- Codex signed in for the Windows account that runs the adapter task.
- Repository `main` updated to the merged chat-first commit.
- Sufficient disk space for the Ollama image, `qwen3:4b`, containers, evidence, and backups.

## 4. One-time deployment

Open Windows PowerShell and run:

```powershell
Set-Location "D:\HermesAgent\workspace\thu-ha-authentic"

git status --short
git pull --ff-only origin main
git rev-parse HEAD

Set-Location ".\agent-workflow-platform-v2"
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force

.\scripts\windows\Deploy-AgentV2.ps1
```

Do not use these switches during initial acceptance:

```text
-EnterShadow
-ConfigureFirewall
-SkipRoutingBenchmark
-InfrastructureOnly
```

Expected high-level outcome:

```text
Workflow AI V2 chat-first isolated runtime and local Manager benchmark PASS.
V1 remains unchanged.
CUTOVER_PHASE=V1_ONLY
```

The first deployment downloads the local model and may take longer than later starts.

## 5. Deployment checks

The deployment must prove:

- PostgreSQL, Redis, MinIO, API, worker, and Ollama are ready;
- `qwen3:4b` is available;
- Hermes and Codex adapters are authenticated and ready;
- `/app` returns the chat-first application;
- signed local session cookie is issued;
- `Hermes-V2-ChatApp` is registered;
- Desktop and Start Menu shortcuts exist;
- the 100-case routing benchmark passes.

Manual verification command:

```powershell
.\scripts\windows\Test-AgentV2.ps1
```

Live routing benchmark:

```powershell
.\scripts\windows\Test-LocalManagerRouting.ps1
```

The latest benchmark report is stored under:

```text
runtime\benchmark\routing-*.json
```

## 6. Daily use

After successful deployment:

1. Double-click **Workflow AI**.
2. Type one natural-language request.
3. Optionally drag files into the composer.
4. Press Enter.
5. Respond only to business clarification or protected-action approval.

The user must not be asked to provide:

- API token;
- owner/workspace ID;
- read/write scope;
- executor;
- risk or autonomy mode;
- Docker, port, PID, PowerShell, or JSON.

## 7. Acceptance scenarios

### 7.1 Read-only chat task

Use a bounded request such as:

> Kiểm tra trạng thái Workflow V2 và tóm tắt, không thay đổi bất kỳ tệp hoặc dịch vụ nào.

Acceptance:

- task enters `QUEUED` then `RUNNING`;
- Manager selects an appropriate route;
- no write scope is granted;
- result appears in the same conversation;
- audit and evidence remain available.

### 7.2 Clarification

Use an intentionally ambiguous request:

> Sửa tài liệu này giúp tôi.

Acceptance:

- task enters `WAITING_INPUT`;
- UI asks a genuine business question;
- it does not ask for executor, risk, scope, command, or token;
- after answering, the same task is requeued and continues.

### 7.3 Approval

Use a protected UAT-only request that is safe to reject, for example asking to publish externally without actually approving it.

Acceptance:

- task enters `WAITING_APPROVAL`;
- the card explains the action and reason;
- **Approve**, **Reject**, and **Copy to ask ChatGPT** are available;
- browser receives only a sanitized approval summary, not raw action payload or secrets;
- rejection stops safely.

### 7.4 Controlled failure

Temporarily stop one non-authoritative V2 component in a controlled UAT window, submit a related read-only task, then restore the component.

Acceptance:

- task stops or retries according to policy;
- UI provides a human summary;
- **Sao chép để hỏi ChatGPT** produces one self-contained report;
- API keys, tokens, cookies, passwords, private keys, and connection credentials are absent;
- no manual PowerShell log collection is required for the copied report.

Do not stop V1. Do not delete volumes. Do not create a destructive fault.

## 8. Attachment checks

Test at least one small file from each required family:

- PDF;
- DOCX or XLSX;
- TXT or MD;
- PNG or JPEG.

Acceptance:

- valid files upload and receive SHA-256 metadata;
- invalid extension is rejected;
- mismatched PDF/image/OpenXML signature is rejected;
- generic ZIP is rejected;
- file is bound to the current conversation and registered scope;
- refresh does not lose the conversation or task link.

## 9. Startup and reboot acceptance

Before reboot:

```powershell
Get-ScheduledTask -TaskName `
  "Hermes-V2-Hermes-HostAdapter", `
  "Hermes-V2-Codex-HostAdapter", `
  "Hermes-V2-ChatApp" |
Select-Object TaskName, State |
Format-Table -AutoSize
```

Reboot Windows. After sign-in:

1. wait for Docker Desktop and the local model to become ready;
2. open **Workflow AI**;
3. confirm the previous conversations remain available;
4. run `Test-AgentV2.ps1` only as a technical acceptance check, not as normal operation.

Acceptance:

```text
REBOOT_RESUME=PASS
NO_POWERSHELL_FOR_NORMAL_USE=TRUE
CONVERSATION_PERSISTENCE=PASS
MODEL_READY=TRUE
ADAPTERS_READY=TRUE
```

On startup failure, the launcher writes and opens:

```text
runtime\diagnostics\startup-latest.txt
```

The file is already sanitized and can be copied into ChatGPT.

## 10. Backup

Create a new chat-first backup:

```powershell
.\scripts\windows\Backup-AgentV2.ps1
```

Required artifacts:

```text
agent_v2.dump
minio-data.tgz
chat-attachments.zip
ollama-models.txt
manifest.json
local configuration copies
```

The manifest must record:

```text
includesChatAttachments=true
includesOllamaModelMetadata=true
cutoverPhase=V1_ONLY
```

Checksums must cover every artifact listed before the manifest is written.

## 11. Restore test

Restore is a deep intervention. Perform it only in the isolated V2 environment with explicit owner approval:

```powershell
.\scripts\windows\Restore-AgentV2.ps1 `
  -BackupDirectory "<full backup directory>" `
  -ConfirmRestore `
  -Confirm
```

Acceptance:

- every checksum passes;
- PostgreSQL restores;
- MinIO restores;
- chat attachments restore;
- API/worker restart;
- smoke test passes;
- conversation and attachment references remain consistent;
- V1 is unchanged.

Backups created before chat attachment support are not sufficient for a complete chat-first restore.

## 12. Failure handling

### Model unavailable

Expected UI:

```text
Workflow AI is not ready.
[Retry]
[Copy error to ask ChatGPT]
```

Technical checks are collected automatically. Do not configure a paid fallback to make readiness green.

### Adapter unavailable

The task may retry if the failure is transient. After retry exhaustion it generates a redacted diagnostic. Restore only the affected V2 adapter.

### Docker unavailable

The hidden launcher attempts to start Docker Desktop and waits within a bounded period. A timeout produces `startup-latest.txt`.

### Benchmark failure

Do not enter Shadow and do not lower the acceptance thresholds merely to pass. Review failures, improve routing instructions, or test the next approved local model candidate.

## 13. Rollback without data deletion

To stop V2 while preserving all data:

```powershell
.\scripts\windows\Stop-AgentV2.ps1
```

Never use:

```text
docker compose down -v
```

During chat-first UAT, V1 remains authoritative. Preserve V2 logs, benchmark reports, diagnostics, audit, evidence, and backup artifacts for analysis.

## 14. Gate before Shadow

Shadow remains blocked until all items pass:

```text
CODE_CI_LINUX=PASS
CODE_CI_WINDOWS=PASS
LOCAL_DEPLOYMENT=PASS
CHAT_FIRST_SMOKE=PASS
ROUTING_BENCHMARK_100=PASS
READ_ONLY_UAT=PASS
CLARIFICATION_UAT=PASS
APPROVAL_UAT=PASS
SAFE_DIAGNOSTIC_UAT=PASS
ATTACHMENT_UAT=PASS
BACKUP_RESTORE=PASS
REBOOT_RESUME=PASS
CUTOVER_PHASE=V1_ONLY
```

Entering Shadow is a separate owner-approved operation and is not part of this runbook's default deployment command.
