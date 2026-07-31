# RUNBOOK — DEPLOYMENT AND ROLLBACK

## 1. Scope

This runbook deploys Workflow AI V2 as a parallel system. It never disables, mutates, or deletes V1.

## 2. Required gates

- Pull request merged after CI passes: type check, migrations, unit/integration tests, build, Compose validation, runtime image build, production dependency audit.
- Repository and image secret scans pass.
- `.env` is created outside Git and contains strong unique values.
- PostgreSQL, Redis, MinIO and Docker volumes have verified backups.
- V1 runtime health is recorded before V2 deployment.
- `cutover_state.phase` remains `V1_ONLY` or `SHADOW`.

## 3. Preflight

```powershell
Set-Location '<V2_WORKSPACE>'
git fetch origin
git switch main
git pull --ff-only
git status --short
docker version
docker compose version
```

The working tree must be clean. Do not reset or rewrite history to resolve drift.

Validate configuration without printing secrets:

```powershell
docker compose --env-file .env -f agent-workflow-platform-v2/compose.yml config --quiet
```

## 4. Build and start

```powershell
Set-Location '<V2_WORKSPACE>\agent-workflow-platform-v2'
docker compose --env-file .env build --pull
docker compose --env-file .env up -d postgres redis minio
docker compose --env-file .env run --rm migrate
docker compose --env-file .env up -d api worker
```

Do not expose PostgreSQL, Redis or MinIO publicly. The API binds to localhost by default.

## 5. Acceptance checks

```powershell
docker compose --env-file .env ps
Invoke-RestMethod http://127.0.0.1:3100/health
Invoke-RestMethod http://127.0.0.1:3100/ready
```

Required:

- PostgreSQL, Redis and MinIO healthy.
- Migration service exits successfully.
- API and worker remain running.
- `/ready` reports `db=true`, `redis=true`, `evidence=true`, `ready=true`.
- No secret value appears in logs.
- V1 continues to operate unchanged.

Run one bounded V2 task using a Sandbox/UAT owner and workspace. Verify task, execution, audit and evidence read-back.

## 6. Rollback triggers

Rollback V2 when:

- readiness fails after the bounded recovery window;
- migration fails;
- owner/workspace isolation fails;
- task or audit evidence is missing;
- queue repeatedly stalls;
- an adapter exceeds registered scope;
- a secret is exposed;
- V1 is affected;
- shadow comparison produces an unexplained material mismatch.

## 7. Rollback procedure

V2 rollback does not change V1:

```powershell
Set-Location '<V2_WORKSPACE>\agent-workflow-platform-v2'
docker compose --env-file .env stop api worker
```

If a release rollback is required, use a verified previous V2 commit or image. Do not rewrite Git history. Restore V2 data only from a verified backup into isolated volumes, then run migration and readiness checks.

Keep PostgreSQL, Redis and MinIO stopped when data integrity is uncertain. Record the incident, correlation IDs, image digest, commit and recovery evidence.

## 8. Post-deployment records

Record:

- deployment commit and image digest;
- migration versions;
- readiness result;
- bounded smoke task and evidence IDs;
- V1 health result;
- cutover phase;
- rollback deadline.

No deployment result is accepted without read-back.
