import pg from 'pg';
import { migrate } from '../src/migrate.js';

export const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://mudatex:mudatex@localhost:5432/mudatex_test';

// Recreates the public schema so every run proves migrations apply from scratch.
export default async function setup() {
  process.env.TEST_DATABASE_URL = TEST_DB_URL;
  const pool = new pg.Pool({ connectionString: TEST_DB_URL });
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(pool);
  await pool.end();
}
