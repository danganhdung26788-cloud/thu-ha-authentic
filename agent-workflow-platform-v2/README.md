# Agent Workflow Platform V2

Production-grade AI workflow orchestration platform built with OpenAI Agents SDK.

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
- OpenAI Agents SDK pinned to `0.13.5`.
- NestJS/Fastify API.
- PostgreSQL source of truth.
- Redis/BullMQ queue, leases and stalled-job handling.
- Transactional outbox and stale-task recovery.
- MinIO evidence objects with SHA-256 metadata.
- Persistent Agent Registry, Tool Registry and owner/workspace grants.
- Docker execution sandbox with path/executable allowlists and resource limits.
- Codex, Hermes and Claude HTTP adapter contracts.
- Structured redacting logs and Prometheus metrics.
- Shadow-run and cutover state tables.

## Autonomy policy

Normal actions inside a registered Sandbox/UAT owner and workspace scope are auto-approved. The runtime interrupts for deep intervention:

- production changes;
- credential or permission changes;
- irreversible deletion without verified backup;
- Git history rewrite;
- deep operating-system changes;
- significant unapproved cost;
- access outside registered owner/workspace scope.

Tool grants are enforced again at the executor boundary. A model decision alone never creates permission.

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
```

Adapter URLs remain empty until their services have passed contract and security tests.

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
3. implement and verify live Codex/Hermes/Claude adapters;
4. pass backup/restore and recovery tests;
5. run shadow comparison;
6. pass dual-run UAT;
7. execute approved cutover;
8. pass seven consecutive soak days.

V1 remains the rollback system until all gates are complete.
