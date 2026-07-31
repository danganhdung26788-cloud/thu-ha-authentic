# RUNBOOK — BACKUP AND RESTORE

## 1. Backup set

A complete V2 backup includes:

- PostgreSQL logical dump;
- MinIO evidence objects;
- Redis AOF snapshot for operational recovery only;
- deployment commit, image digests and migration list;
- configuration reference names without secret values;
- SHA-256 manifest.

PostgreSQL remains the source of truth. Redis is not authoritative.

## 2. Backup rules

- Store backups outside the runtime workspace and outside Git.
- Never include `.env`, API keys, tokens, passwords or credential files.
- Encrypt backup archives at rest.
- Generate a SHA-256 manifest.
- Test restore into isolated volumes before marking a backup valid.

## 3. PostgreSQL backup

```powershell
docker compose --env-file .env exec -T postgres `
  pg_dump -U agent_v2 -d agent_v2 --format=custom `
  > '<BACKUP_ROOT>\agent-v2-postgres.dump'
```

## 4. MinIO backup

Use an approved MinIO client profile whose credential is stored outside the repository:

```powershell
mc mirror --overwrite '<MINIO_ALIAS>/<BUCKET>' '<BACKUP_ROOT>/minio-evidence'
```

## 5. Redis backup

Trigger persistence and copy the AOF directory only after confirming the operation is scoped to the V2 Redis instance. Redis backup is used to accelerate recovery; task state must always be reconciled against PostgreSQL and the transactional outbox.

## 6. Manifest

Create a manifest containing relative path, size and SHA-256 for every backup file. Do not record secrets or raw environment contents.

## 7. Isolated restore test

Create isolated PostgreSQL, Redis and MinIO volumes. Do not restore over live volumes.

Restore PostgreSQL:

```powershell
Get-Content '<BACKUP_ROOT>\agent-v2-postgres.dump' -AsByteStream | `
  docker exec -i '<ISOLATED_POSTGRES_CONTAINER>' `
  pg_restore -U agent_v2 -d agent_v2 --clean --if-exists
```

Restore evidence to an isolated bucket and verify every object against database metadata and SHA-256.

Run:

- all migration checks;
- `/ready`;
- task/execution/audit count reconciliation;
- evidence object and checksum reconciliation;
- one read-only task;
- stale-lock and outbox recovery checks.

## 8. Restore acceptance

A restore is valid only when:

- manifest hashes match;
- database migrations are consistent;
- no owner/workspace cross-read occurs;
- all referenced evidence exists and hashes match;
- unpublished outbox events can be republished idempotently;
- completed tasks are not executed again;
- API and worker readiness pass;
- V1 remains untouched.

## 9. Recovery priority

1. Preserve evidence and logs.
2. Stop V2 API and worker.
3. Restore PostgreSQL into isolated storage.
4. Restore MinIO evidence.
5. Recreate Redis from empty state or verified AOF.
6. Run migrations and reconciliation.
7. Start V2 in `SHADOW` only.
8. Resume higher phases after acceptance and owner approval.
