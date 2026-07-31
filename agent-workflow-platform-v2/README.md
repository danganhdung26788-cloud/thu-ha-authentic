# Agent Workflow Platform V2

Production-grade AI workflow orchestration platform built with OpenAI Agents SDK.

## Status

```text
DECISION=APPROVED
MODE=GREENFIELD_PARALLEL
V1_RUNTIME_CHANGED=FALSE
V1_DELETION_ALLOWED=FALSE
CURRENT_PHASE=FOUNDATION
```

This directory is a new codebase. It does not share task state, queue leases, runtime folders, secrets or write paths with V1.

## Objectives

- Convert Routing 3.0 into executable, testable orchestration logic.
- Allow autonomous work inside registered Sandbox/UAT scopes.
- Pause only for deep intervention.
- Preserve owner/workspace isolation, audit, recovery and rollback.
- Import V1 capabilities only through versioned contracts and adapters.

## Runtime baseline

- Node.js 22+
- TypeScript strict mode
- OpenAI Agents SDK pinned to `0.13.5`
- Zod v4 schemas
- PostgreSQL source of truth (next phase)
- Redis/BullMQ queue and leases (next phase)
- Docker sandbox on Windows (next phase)
- Object storage for evidence and artifacts (next phase)

## Autonomy policy

Normal operations inside Sandbox/UAT are auto-approved. The runtime must interrupt for:

- production changes;
- credential or permission changes;
- irreversible deletion without verified backup;
- Git history rewrite;
- deep operating-system changes;
- significant unapproved cost;
- access outside registered owner/workspace scope.

## Current foundation

- owner-scoped execution contract;
- structured Manager Agent decision;
- reusable `Runner` with bounded turns;
- sensitive-data tracing disabled by default;
- policy engine for `AUTO_APPROVE`, `REQUIRE_APPROVAL` and `DENY`;
- deterministic policy tests.

## Local configuration

Copy `.env.example` to `.env`. Never commit real values.

Required values include:

```text
OPENAI_API_KEY
OPENAI_MANAGER_MODEL
TASK_ID
CORRELATION_ID
OWNER_ID
WORKSPACE_ID
READ_SCOPE_JSON
WRITE_SCOPE_JSON
```

## Commands

```bash
npm install
npm run check
npm test
npm run build
```

Example run:

```bash
npm run dev -- "Inspect the assigned workspace and route this task"
```

## Migration rule

V1 remains active and unchanged until V2 passes:

1. foundation and threat-model review;
2. control-plane and queue tests;
3. agent and executor integration tests;
4. shadow mode;
5. dual-run comparison;
6. backup/restore and recovery tests;
7. seven-day soak;
8. owner cutover approval.

V1 deletion requires a separate decommission runbook and an expired rollback window.
