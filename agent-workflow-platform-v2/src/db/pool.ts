import pg from 'pg';
import { getEnv } from '../config/env.js';

const { Pool } = pg;

let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  pool ??= new Pool({
    connectionString: getEnv().DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: 'agent-workflow-platform-v2',
  });
  return pool;
}

export async function withTransaction<T>(
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
