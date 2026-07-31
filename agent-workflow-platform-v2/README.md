# Agent Workflow Platform V2

Production-grade multi-provider AI workflow orchestration platform built with OpenAI Agents SDK.

## Status

```text
DECISION=APPROVED
MODE=GREENFIELD_PARALLEL
V1_RUNTIME_CHANGED=FALSE
V1_DELETION_ALLOWED=FALSE
CODEBASE=PRODUCTION_BASELINE
RUNTIME_DEPLOYED=FALSE
CUTOVER_PHASE=V1_ONLY
GEMINI_RUNTIME=DISABLED
GEMINI_API_COST=0
```

This directory is a separate codebase. V2 does not share task state, queue leases, runtime folders, object buckets, secrets or write paths with V1.

## Architecture

- Node.js 22+ and TypeScript strict mode.
- OpenAI Agents SDK pinned to `0.13.5` for central orchestration.
- Official Codex TypeScript SDK pinned for repository automation through the local Codex login.
- Gemini integration remains compiled but disabled until the owner explicitly enables API credentials and billing.
- NotebookLM source-grounded research handoff workflow.
- Canva Connect API/MCP adapter contract for approved design work.
- NestJS/Fastify API and internal `/admin` operations dashboard.
- PostgreSQL source of truth.
- Redis/BullMQ queue, leases and stalled-job handling.
- Transactional outbox and stale-task recovery.
- MinIO evidence objects with SHA-256 metadata.
- Persistent Agent Registry, Tool Registry and owner/workspace grants.
- Docker control plane plus bounded Windows host adapters for Hermes and Codex.
- Structured redacting logs and Prometheus metrics.
- Shadow-run and cutover state tables.

## Specialized routing

```text
OpenAI Manager      -> orchestration and final structured route
OpenAI Specialist   -> bounded extraction, classification and reporting
NotebookLM          -> closed-source research package and citation handoff
Canva               -> approved design draft, template autofill and export
Codex               -> code, repository, tests, CI and bounded rollback work
Hermes               -> allowlisted PowerShell scripts, files, schedules, monitoring and recovery
Claude Review        -> independent review when its adapter is configured
Gemini               -> disabled until separately approved
```

## Windows host runtime

Two authenticated adapters run outside Docker so they can operate the Windows host:

```text
Hermes adapter -> TCP 3201
Codex adapter  -> TCP 3202
```

Mandatory controls:

- exact owner and workspace registration;
- task read/write scope checks;
- executable and script allowlists;
- no arbitrary inline PowerShell;
- Scheduled Task prefix `Hermes-V2-`;
- target read-back after file writes;
- bounded time and output size;
- per-task receipts for non-retryable results;
- retryable failures are not cached as final receipts;
- Codex network access disabled by default;
- no force-push, credential, permission or billing changes in normal Sandbox/UAT work.

See `docs/RUNBOOK_WINDOWS_RUNTIME_ACTIVATION.md`.

## Operations dashboard

After the API starts, open:

```text
http://127.0.0.1:3100/admin
```

The internal dashboard supports:

- creating a task from a business objective;
- filtering by owner, workspace and status;
- viewing executions, audit and evidence metadata;
- approving or rejecting deep interventions;
- checking adapter health and cutover phase.

The API token is entered locally and stored only in the browser tab `sessionStorage`. API endpoints remain bearer-authenticated.

## Autonomy policy

Normal actions inside a registered Sandbox/UAT owner and workspace scope are auto-approved. The runtime interrupts for deep intervention:

- production changes;
- credential or permission changes;
- irreversible deletion without verified backup;
- Git history rewrite;
- deep operating-system changes;
- significant unapproved cost;
- access outside registered owner/workspace scope;
- external publication or sharing.

A model decision alone never creates permission. Tool grants and scope checks are enforced again at the executor boundary.

## Control-plane lifecycle

```text
QUEUED
  -> RUNNING
  -> COMPLETED | RETRY_WAIT | WAITING_APPROVAL | FAILED
```

Task creation is idempotent within `owner_id + workspace_id + idempotency_key`. PostgreSQL is authoritative; Redis may be recreated and reconciled from the transactional outbox.

## Required local configuration

The Windows bootstrap generates local random values for:

```text
POSTGRES_PASSWORD
MINIO_ACCESS_KEY
MINIO_SECRET_KEY
API_AUTH_TOKEN
ADAPTER_AUTH_TOKEN
```

AI execution also requires approved OpenAI configuration:

```text
OPENAI_API_KEY
OPENAI_MANAGER_MODEL
OPENAI_SPECIALIST_MODEL
```

Gemini remains intentionally empty:

```text
GOOGLE_API_KEY=
GEMINI_MODEL=
```

No real secret may be committed to Git.

## Validation

```bash
npm ci
npm run check
npm run migrate
npm test
npm run build
npm audit --omit=dev --audit-level=high
```

CI validates the control plane on Ubuntu and parses, type-checks, tests and builds the host runtime on Windows Server 2025.

## Windows deployment

From `agent-workflow-platform-v2`:

```powershell
.\scripts\windows\Deploy-AgentV2.ps1
```

Firewall modification is a separate deep-intervention gate:

```powershell
.\scripts\windows\Deploy-AgentV2.ps1 -ConfigureFirewall
```

The script creates local configuration, installs the lockfile, runs tests/build, starts Docker services, registers hidden host-adapter Scheduled Tasks and runs smoke tests. It does not modify V1 or enter Shadow unless explicitly requested.

## Migration phases

```text
V1_ONLY -> SHADOW -> DUAL_RUN -> V2_PRIMARY -> V1_DECOMMISSIONED
```

No phase may be skipped. V1 deletion requires 7/7 soak days, an expired rollback window, verified backup and owner approval.

## Runtime acceptance still required

Code and CI do not prove that the user's Windows runtime is live. Before V2 can become primary, the machine must provide evidence for:

1. isolated deployment and smoke test;
2. external secrets and approved OpenAI models;
3. live Hermes and Codex adapter contract tests;
4. backup and restore test;
5. NotebookLM handoff verification;
6. Shadow comparison;
7. dual-run UAT;
8. approved cutover;
9. seven consecutive soak days.

V1 remains the rollback system until all gates are complete.
