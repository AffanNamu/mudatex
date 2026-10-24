import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/migrate.js';

describe('migrations', () => {
  const db = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  afterAll(() => db.end());

  it('are idempotent when re-run', async () => {
    expect(await migrate(db)).toEqual([]);
  });

  it('leave every table protected by row-level security, and strip public client roles of access', async () => {
    const unprotected = await db.query("SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND NOT c.relrowsecurity");
    expect(unprotected.rows).toEqual([]);

    // Imitate a hosted platform: public client roles that were granted everything by default.
    await db.query("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF; END $$");
    await db.query('GRANT USAGE ON SCHEMA public TO anon');
    await db.query('GRANT SELECT, INSERT ON users TO anon');
    await db.query('CREATE TABLE IF NOT EXISTS lockdown_probe (id int)');
    await db.query('GRANT ALL ON lockdown_probe TO anon');
    try {
      expect((await db.query("SELECT has_table_privilege('anon', 'users', 'SELECT') AS ok")).rows[0].ok).toBe(true);
      await migrate(db);   // nothing to apply, but the lock-down runs every time
      expect((await db.query("SELECT has_table_privilege('anon', 'users', 'SELECT') AS ok")).rows[0].ok).toBe(false);
      expect((await db.query("SELECT has_table_privilege('anon', 'lockdown_probe', 'INSERT') AS ok")).rows[0].ok).toBe(false);
      expect((await db.query("SELECT relrowsecurity FROM pg_class WHERE relname = 'lockdown_probe'")).rows[0].relrowsecurity).toBe(true);
    } finally {
      await db.query('DROP TABLE IF EXISTS lockdown_probe');
    }
  });

  it('refuse to run when an applied file was edited', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'mig-'));
    await writeFile(path.join(dir, '9001_x.sql'), 'CREATE TABLE IF NOT EXISTS mig_probe (id int);');
    await migrate(db, dir);
    await writeFile(path.join(dir, '9001_x.sql'), 'CREATE TABLE IF NOT EXISTS mig_probe (id int, extra int);');
    await expect(migrate(db, dir)).rejects.toThrow(/modified after it was applied/);
    await db.query("DELETE FROM schema_migrations WHERE name = '9001_x.sql'; DROP TABLE IF EXISTS mig_probe;");
  });
});
