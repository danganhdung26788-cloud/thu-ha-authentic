# Threat Model — Agent Workflow Platform V2

- Version: 0.1
- Date: 2026-07-31
- Owner: danganhdung

## Assets

- Owner and workspace boundaries.
- Task, approval, execution and audit records.
- Source documents and generated artifacts.
- Repository and runtime credentials.
- Shell, filesystem, network and deployment capabilities.
- Serialized Agents SDK run state and sessions.

## Trust boundaries

1. User/Chat interface → Control Plane API.
2. Control Plane → Agent Orchestrator.
3. Agent Orchestrator → Tool/Executor adapters.
4. Executor adapters → Docker sandbox or external services.
5. V2 migration adapter → V1 read-only sources.
6. Application audit → evidence/object storage.

## Primary threats

### Cross-owner access

An agent or tool reads or writes another owner’s workspace.

Controls:
- owner/workspace IDs are mandatory context fields;
- path and resource checks execute at the tool boundary;
- deny by default when scope is missing or mismatched;
- integration tests use two owners and negative access cases.

### Prompt or document injection

Untrusted content attempts to override routing or request unsafe tools.

Controls:
- local execution context is not model-controlled;
- tool exposure is determined by policy and runtime state;
- tool input guardrails validate every function-tool call;
- external content is marked untrusted and cannot expand scope.

### Excessive shell access

The model runs arbitrary commands on the host.

Controls:
- Docker sandbox is the default execution boundary on Windows;
- command and path allowlists;
- no host shell tool exposed directly to the model;
- time, CPU, memory and output limits;
- snapshots and rollback before mutation.

### Irreversible or deep intervention

The agent changes production, credentials, permissions, Git history or operating-system configuration.

Controls:
- policy outcome must be `REQUIRE_APPROVAL`;
- resumable approval state is persisted;
- no automatic fallback from rejection to a different destructive tool;
- all decisions and resumed actions are audited.

### Secret leakage

Secrets appear in repository, logs, prompts, traces or artifacts.

Controls:
- secrets external to Git;
- secret scanning in CI;
- sensitive trace content disabled by default;
- logs use allowlisted fields and redaction;
- serialized context must not contain credentials.

### Duplicate execution and stale locks

A retry or restart repeats side effects.

Controls:
- idempotency key per task/action;
- queue lease and stale-lock recovery;
- execution state transition constraints;
- tool-specific read-back before marking success.

### Compromised dependency or SDK update

A dependency update changes behavior or introduces malicious code.

Controls:
- exact Agents SDK version pin;
- committed lockfile before release;
- dependency audit and provenance review;
- versioned run state and migration tests;
- upgrades occur through dedicated PRs.

### Audit tampering

An executor alters evidence to hide actions.

Controls:
- append-only audit events;
- artifact hashes;
- executor output is not the sole success source;
- read-back from the target system;
- evidence storage separated from sandbox write scope.

## Security acceptance gates

- Negative cross-owner tests PASS.
- Tool/path escape tests PASS.
- Prompt-injection tests cannot widen tool scope.
- Deep intervention pauses and resumes correctly.
- Restart recovery does not duplicate side effects.
- Secret scan reports zero high-confidence findings.
- Backup/restore and rollback tests PASS.

## Residual risk

LLM decisions remain probabilistic. Therefore permissions, scope, idempotency, approvals and official audit must remain deterministic application controls and cannot be implemented only as prompt instructions.
