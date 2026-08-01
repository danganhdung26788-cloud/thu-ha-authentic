# CWC-P7 Production rollout and rollback

CWC-P7 is fail-closed. A merged technical package, passing CI, or a generated release candidate is not a production activation.

## Mandatory runtime gates

```text
CWC-P3 owner Windows receipt=PASS
CWC-P4 real Secure MCP Tunnel receipt=PASS
CWC-P5 real ChatGPT web connection evidence=PASS
CWC-P6 controlled-write UAT evidence=PASS and teardownComplete=true
Git working tree=clean
Owner approval=exact candidate hash and commit
```

The current Plus account cannot pass CWC-P5, so production activation remains blocked.

## Candidate creation

`New-ProductionReleaseCandidate.ps1` validates all four phase receipts, validates the strict read-only rollback config and narrow controlled-write config, hashes every artifact, requires a clean Git tree, and writes:

```text
runtime/cwc-p7/release-candidate.json
```

Its state is always:

```text
status=CANDIDATE_READY_NOT_ACTIVATED
ownerApproval=false
production=false
```

The candidate generator does not start a process, tunnel, app, Scheduled Task, or write capability.

## Approval boundary

Owner approval must reference the exact candidate SHA-256 and repository commit. Any changed evidence, configuration, code commit, workspace, root, script, action, or tunnel requires a new candidate and a new approval.

There is deliberately no automatic production activation script in this package while the required external gates are blocked. Activation must be introduced only through a separate reviewed Change Request after a real eligible ChatGPT workspace and all runtime receipts exist.

## Monitoring

`Get-BridgeOperationalStatus.ps1` performs only read-only health checks for the local bridge and Secure MCP Tunnel and writes:

```text
runtime/cwc-p7/operational-status-latest.json
```

It does not stop/start processes, change configuration, delete data, or claim production.

## Rollback

`Invoke-BridgeSafeRollback.ps1` requires:

- explicit owner approval switch;
- exact SHA-256 of a strict read-only workspace registry;
- verified tunnel-client path when a tunnel PID exists.

Sequence:

```text
verify rollback config hash and read-only invariants
-> stop verified tunnel and bridge
-> backup current workspace registry
-> install read-only registry
-> read-back SHA-256
-> write validated ROLLED_BACK receipt
-> leave runtime stopped
```

Rollback never restarts automatically. Restart and reconnect require a separate decision after the read-only state has been inspected.

## Release evidence states

- `BLOCKED`: external/runtime gate missing; production false.
- `CANDIDATE_READY_NOT_ACTIVATED`: all evidence/config hashes ready; owner approval false; production false.
- `ACTIVATED`: allowed only by a future reviewed activation workflow with owner approval, smoke PASS, read-back PASS and production true.
- `ROLLED_BACK`: verified read-only config restored; production false; runtime not restarted.

`validate-cwc-p7-release-evidence.mjs` rejects missing hashes, broken P3-P6 gates, secrets/raw tunnel IDs, false rollback/monitoring/backup claims, candidate activation claims, incomplete activated evidence and incomplete rollback evidence.

## Current status

```text
CWC-P0..P2=CLOSED
CWC-P3=TECHNICAL_AND_WINDOWS_CI_PASS_OWNER_HOST_NOT_RUN
CWC-P4=TECHNICAL_PASS_REAL_TUNNEL_NOT_RUN
CWC-P5=TECHNICAL_PASS_BLOCKED_CURRENT_PLUS
CWC-P6=TECHNICAL_PASS_RUNTIME_WRITE_DISABLED
CWC-P7=TECHNICAL_PACKAGE_READY_PRODUCTION_BLOCKED
CONNECTED_TO_CHATGPT=false
LOCAL_WRITE=false
PRODUCTION=false
```
