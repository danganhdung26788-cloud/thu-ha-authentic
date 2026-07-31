import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closePool, withTransaction } from './pool.js';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

async function resolveMigrationsDir(): Promise<string> {
  const candidates = [
    path.resolve(moduleDir, '../../migrations'),
    path.resolve(moduleDir, '../../../migrations'),
    path.resolve(process.cwd(), 'migrations'),
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next known runtime layout.
    }
  }
  throw new Error(`Migrations directory not found. Checked: ${candidates.join(', ')}`);
}

async function migrate(): Promise<void> {
  const migrationsDir = await resolveMigrationsDir();
  const files = (await readdir(migrationsDir))
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .sort();

  await withTransaction(async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
  });

  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    await withTransaction(async (client) => {
      const existing = await client.query<{ version: string }>(
        'SELECT version FROM schema_migrations WHERE version = $1',
        [version],
      );
      if (existing.rowCount) return;
      const sql = await readFile(path.join(migrationsDir, file), 'utf8');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(version) VALUES($1)', [version]);
    });
    process.stdout.write(`Applied migration ${version}\n`);
  }
}

migrate()
  .then(() => closePool())
  .catch(async (error: unknown) => {
    console.error(error);
    await closePool();
    process.exitCode = 1;
  });
