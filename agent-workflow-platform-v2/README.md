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
```

This directory is a separate codebase. V2 does not share task state, queue leases, runtime folders, object buckets, secrets or write paths with V1.

## Architecture

- Node.js 22+ and TypeScript strict mode.
- OpenAI Agents SDK pinned to `0.13.5` for central orchestration.
- Google GenAI SDK pinned for the Gemini specialist executor.
- NotebookLM source-grounded research handoff workflow.
- Canva Connect API/MCP adapter contract for approved design work.
- NestJS/Fastify API.
- PostgreSQL source of truth.
- Redis/BullMQ queue, leases and stalled-job handling.
- Transactional outbox and stale-task recovery.
- MinIO evidence objects with SHA-256 metadata.
- Persistent Agent Registry, Tool Registry and owner/workspace grants.
- Docker execution sandbox with path/executable allowlists and resource limits.
- Codex, Hermes, Claude and Canva HTTP adapter contracts.
- Structured redacting logs and Prometheus metrics.
- Shadow-run and cutover state tables.

## Specialized AI routing

```text
OpenAI Manager      -> orchestration and final structured route
OpenAI Specialist   -> bounded extraction, classification and reporting
Gemini              -> multimodal analysis, Google ecosystem work and cross-checking
NotebookLM          -> closed-source research package and citation handoff
Canva               -> approved design draft, template autofill and export
Codex               -> code, repository, tests, CI, deploy and rollback
Hermes               -> PowerShell, files, schedules, monitoring and recovery
Claude Review        -> independent review
```

Gemini becomes available only when `GOOGLE_API_KEY` and `GEMINI_MODEL` are configured and its registry status is promoted after contract testing. NotebookLM does not pretend to have a runtime API: V2 prepares a private source package and requires a reviewed result with citations to be registered back. Canva requires an OAuth/Connect API or MCP adapter; external publishing remains a deep intervention.

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

Tool grants are enforced again at the executor boundary. A model decision alone never creates permission. Canva cannot alter approved official facts, figures or wording.

## Control-plane lifecycle

```text
QUEUED
  -> RUNNING
  -> COMPLETED | RETRY_WAIT | WAITING_APPROVAL | FAILED
```

Task creation is idempotent within `owner_id + workspace_id + idempotency_key`. PostgreSQL is authoritative; Redis may be recreated and reconciled from the transactional outbox.

## Configuration

Copy `.env.example` to a local `.env`. Never commit real values.

Production topology requires unique values for:

```text
POSTGRES_PASSWORD
MINIO_ACCESS_KEY
MINIO_SECRET_KEY
API_AUTH_TOKEN
ADAPTER_AUTH_TOKEN
OPENAI_API_KEY
OPENAI_MANAGER_MODEL
OPENAI_SPECIALIST_MODEL
GOOGLE_API_KEY
GEMINI_MODEL
```

Canva credentials belong in the separately deployed adapter/OAuth service. Adapter URLs remain empty until their services have passed contract and security tests. A Google AI Pro or Canva Pro subscription is not stored as a runtime credential and does not replace API/OAuth setup.

## Local validation

```bash
npm ci
npm run check
npm run migrate
npm test
npm run build
npm audit --omit=dev --audit-level=high
```

Validate the service topology:

```bash
docker compose --env-file .env -f compose.yml config --quiet
docker compose --env-file .env build
```

## Start V2 in parallel

Follow `docs/RUNBOOK_DEPLOYMENT_AND_ROLLBACK.md`. V1 must remain active and unchanged. The API is bound to localhost by default.

## Migration phases

```text
V1_ONLY -> SHADOW -> DUAL_RUN -> V2_PRIMARY -> V1_DECOMMISSIONED
```

See `docs/RUNBOOK_SHADOW_CUTOVER_AND_DECOMMISSION.md`. No phase may be skipped. V1 deletion requires 7/7 soak days, an expired rollback window and a separate destructive-change approval.

## Production acceptance still required

The codebase and CI baseline do not mean the Windows runtime is live. Before V2 can become primary, the following must be completed with real runtime evidence:

1. deploy isolated V2 services;
2. configure strong external secrets and approved AI models;
3. implement and verify live Codex/Hermes/Claude/Canva adapters;
4. contract-test Gemini with bounded API credentials and cost limits;
5. verify the NotebookLM source-package and reviewed-result workflow;
6. pass backup/restore and recovery tests;
7. run shadow comparison;
8. pass dual-run UAT;
9. execute approved cutover;
10. pass seven consecutive soak days.

V1 remains the rollback system until all gates are complete.
