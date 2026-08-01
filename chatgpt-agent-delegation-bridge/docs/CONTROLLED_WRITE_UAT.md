# CWC-P6 Controlled write UAT

CWC-P6 introduces bounded local mutation without giving a specialist AI or ChatGPT an unrestricted operation channel.

## External gate

CWC-P6 may run only after:

```text
CWC_P3_WINDOWS_READ_ONLY_UAT=PASS
CWC_P4_SECURE_MCP_TUNNEL_READ_ONLY_UAT=PASS
CWC_P5_CHATGPT_READ_ONLY_CONNECTION_UAT=PASS
CHATGPT_WORKSPACE_PLAN=BUSINESS|ENTERPRISE|EDU
OWNER_APPROVAL=TRUE
```

Pro read-only custom MCP access is not sufficient for write/modify actions. The current Plus account remains blocked and must not activate this phase.

## Two-step execution contract

```text
ChatGPT builds exact bounded plan
  -> prepare_local_operations
       validates workspace, paths, scripts, executables, operation inputs
       produces approvalId + planHash + safe summary + expiry
       performs no mutation
  -> ChatGPT shows exact summary to the user
  -> explicit user approval
  -> execute_local_operations
       accepts approvalId + planHash + idempotencyKey only
       consumes approval before execution
       executes the stored plan
       read-back verifies supported writes
```

`execute_local_operations` cannot accept or alter operation payloads. Changing any operation, content, path, script, argument, Scheduled Task, or workspace requires a new prepare call and a new user approval.

## Approval properties

```text
STORE=MEMORY_ONLY
PERSISTED=false
DEFAULT_TTL_SECONDS=300
MIN_TTL_SECONDS=30
MAX_TTL_SECONDS=900
SINGLE_USE=true
PLAN_HASH=SHA256_CANONICAL_PLAN_AND_WORKSPACE
CONSUMED_BEFORE_EXECUTION=true
REPLAY_SAME_IDEMPOTENCY_KEY=RETURNS_ORIGINAL_RESULT
REPLAY_DIFFERENT_IDEMPOTENCY_KEY=BLOCKED
RESTART=ALL_APPROVALS_REVOKED
```

A failed or interrupted execution consumes its grant. Prepare and approve the plan again rather than replaying uncertain mutations.

## Separate write profile

Do not modify the read-only `config/workspaces.json`. Create a dedicated UAT sandbox whose leaf name starts with `cwc-p6-uat-` and generate an inactive candidate profile:

```powershell
.\scripts\windows\New-ControlledWriteUatProfile.ps1 `
  -P5EvidencePath '.\runtime\cwc-p5\evidence.json' `
  -WorkspaceRoot 'D:\HermesAgent\workspace\thu-ha-authentic' `
  -ApprovedWriteRoot 'D:\HermesAgent\workspace\thu-ha-authentic\runtime\cwc-p6-uat-sandbox'
```

The generator:

- validates real P5 PASS evidence;
- rejects Plus and Pro for write UAT;
- refuses the whole workspace as write root;
- requires a dedicated sandbox name;
- registers no script unless explicitly supplied;
- creates `runtime/cwc-p6/workspaces.write-uat.json`;
- writes a SHA-256 manifest;
- does not activate the profile, start the bridge, create an app, or change production.

## Controlled test scenarios

Run only inside the dedicated sandbox.

1. **File write and read-back**
   - prepare one UTF-8 file write;
   - verify the file does not exist after prepare;
   - approve exact path, byte count and SHA-256;
   - execute and verify read-back hash.

2. **Wrong hash**
   - call execute with an altered hash;
   - expect `LOCAL_APPROVAL_HASH_MISMATCH`;
   - execute once with the correct hash.

3. **Single use**
   - execute successfully;
   - repeat with another idempotency key;
   - expect `LOCAL_APPROVAL_CONSUMED`.

4. **Idempotent retry**
   - repeat the exact execute call using the same idempotency key;
   - receive the original result without a second mutation.

5. **Expiration**
   - wait beyond TTL;
   - expect expired/not-found approval;
   - prepare and approve again.

6. **Path escape**
   - prepare `..`, symlink or junction escape;
   - expect rejection before approval creation.

7. **Optional PowerShell script**
   - use only a `.ps1` explicitly registered in the generated profile;
   - no inline PowerShell and no arbitrary executable.

8. **Optional Scheduled Task**
   - use only prefix `CWC-P6-UAT-`;
   - delete test task during teardown.

## ChatGPT approval wording

The user-facing approval request must include:

- workspace ID;
- expiry;
- operation count and exact tool IDs;
- exact read/write paths;
- file byte count and SHA-256 for writes;
- script path and arguments;
- Scheduled Task name/action;
- rollback or teardown instruction.

Do not ask “Cho phép hệ thống xử lý?” or any similarly vague approval.

## Teardown

- stop the write-profile bridge and tunnel;
- revoke all in-memory approvals by process stop/restart;
- delete only files/tasks created inside the UAT sandbox and prefix;
- preserve manifests, receipts and audit evidence;
- restore and reconnect the original read-only app if needed.

## Acceptance

```text
P5_PASS_VERIFIED=true
WRITE_PROFILE_SEPARATE=true
WRITE_ROOT_NARROW=true
PREPARE_PERFORMS_NO_MUTATION=true
EXECUTE_ACCEPTS_NO_PLAN_PAYLOAD=true
PLAN_HASH_BOUND=true
APPROVAL_SINGLE_USE=true
APPROVAL_EXPIRES=true
IDEMPOTENT_RETRY=true
READ_BACK=true
PATH_ESCAPE_BLOCKED=true
WRITE_UAT_SANDBOX_ONLY=true
PRODUCTION=false
```

## Current state

```text
CWC_P6_TECHNICAL_PACKAGE=IMPLEMENTED
CURRENT_ACCOUNT_PLAN=PLUS
RUNTIME_WRITE_UAT=BLOCKED_P5_AND_PLAN
LOCAL_WRITE_ACTIVATED=false
CONNECTED_WRITE_APP=false
PRODUCTION=false
```
