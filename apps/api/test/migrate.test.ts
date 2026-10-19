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

  it('refuse to run when an applied file was edited', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'mig-'));
    await writeFile(path.join(dir, '9001_x.sql'), 'CREATE TABLE IF NOT EXISTS mig_probe (id int);');
    await migrate(db, dir);
    await writeFile(path.join(dir, '9001_x.sql'), 'CREATE TABLE IF NOT EXISTS mig_probe (id int, extra int);');
    await expect(migrate(db, dir)).rejects.toThrow(/modified after it was applied/);
    await db.query("DELETE FROM schema_migrations WHERE name = '9001_x.sql'; DROP TABLE IF EXISTS mig_probe;");
  });
});
