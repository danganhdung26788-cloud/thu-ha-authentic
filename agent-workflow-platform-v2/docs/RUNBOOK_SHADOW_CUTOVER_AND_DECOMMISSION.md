# RUNBOOK — SHADOW, DUAL-RUN, CUTOVER AND V1 DECOMMISSION

## 1. State machine

Allowed phases:

```text
V1_ONLY -> SHADOW -> DUAL_RUN -> V2_PRIMARY -> V1_DECOMMISSIONED
```

No phase may be skipped. A failure returns the system to the most recent accepted phase. V1 remains authoritative until `V2_PRIMARY` is explicitly approved.

## 2. V1_ONLY

- V1 operates normally.
- V2 infrastructure may be deployed but receives no production trigger.
- Verify V2 migrations, readiness, backup/restore and bounded Sandbox/UAT tasks.
- Capture V1 baseline: task counts, schedules, queue state, health, code commit and configuration references.

Exit gate: V2 foundation CI, deployment smoke, isolation, backup/restore and security checks pass.

## 3. SHADOW

- Duplicate a sanitized task envelope to V2.
- V2 may read only the exact registered source scope.
- V2 must not write to V1 data, send external messages, deploy or mutate production.
- Store V1 result, V2 result and comparison in `shadow_runs`.

Evaluate:

- routing decision;
- extracted facts and output structure;
- owner/workspace isolation;
- execution time and API cost;
- policy and approval decision;
- evidence completeness;
- recovery behavior.

Exit gate: an agreed sample has no unexplained material mismatch and no cross-owner access.

## 4. DUAL_RUN

- Both systems process approved UAT tasks.
- Writes target separate V1 and V2 destinations.
- No shared queue, database, object bucket or runtime state.
- Compare results after each task.
- Any high-risk mismatch pauses the phase and creates an incident.

Required tests:

- duplicate submission and idempotency;
- API/worker restart and resume;
- Redis outage with transactional outbox recovery;
- stale running task recovery;
- approval approve/reject;
- adapter unavailable and retry;
- backup/restore;
- owner/workspace isolation;
- evidence checksum verification.

Exit gate: UAT acceptance and recovery matrix pass.

## 5. V2_PRIMARY

Before switching triggers:

- take fresh V1 and V2 backups;
- record trigger, Scheduled Task, webhook and queue ownership;
- set a rollback deadline;
- confirm V1 can be re-enabled without data loss;
- freeze structural changes during cutover.

Switch only the approved trigger to V2. Keep V1 runtime stopped or read-only; do not delete it.

Run a minimum seven-day soak. Each day verify:

- API, worker, PostgreSQL, Redis and MinIO health;
- queue depth and stalled jobs;
- task/execution/audit/evidence consistency;
- owner/workspace isolation;
- approval interruptions;
- adapter health;
- error rate, latency and API cost;
- backup success;
- V1 rollback readiness.

Any failed day restarts the seven-day soak after recovery.

## 6. Rollback from V2_PRIMARY

- Stop new V2 trigger intake.
- Preserve V2 state and evidence.
- Re-enable V1 trigger according to its verified runbook.
- Reconcile tasks accepted during the cutover window.
- Do not execute the same external side effect twice.
- Set `cutover_state.phase` back to the accepted phase and record the reason.

## 7. V1_DECOMMISSIONED

V1 deletion is allowed only when:

- V2 has passed 7/7 soak days;
- the rollback deadline has expired;
- all V1 records and artifacts are backed up and checksummed;
- no trigger, integration or user depends on V1;
- owner signs off a decommission plan;
- a separate destructive-change approval is recorded.

Decommission order:

1. Disable V1 triggers.
2. Export and checksum V1 state and evidence.
3. Revoke V1 credentials and permissions.
4. Archive repository/tag and documentation.
5. Remove V1 runtime containers/tasks.
6. Retain backup for the approved retention period.
7. Delete source data only under a separate explicit instruction.

This runbook never authorizes immediate V1 deletion.
