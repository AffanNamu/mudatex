import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './db.js';
import { withTx } from './db.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = path.resolve(here, '../migrations');

/**
 * Applies pending SQL migrations in filename order, each in its own transaction.
 * An applied migration whose file has since changed is an error: fix forward
 * with a new migration instead of editing history.
 */
export async function migrate(db: Db, dir = MIGRATIONS_DIR): Promise<string[]> {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY,
    checksum text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);

  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];

  for (const file of files) {
    const sql = await readFile(path.join(dir, file), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');

    await withTx(db, async (tx) => {
      // Serialize concurrent runners.
      await tx.query('SELECT pg_advisory_xact_lock(727274)');
      const { rows } = await tx.query<{ checksum: string }>(
        'SELECT checksum FROM schema_migrations WHERE name = $1',
        [file],
      );
      const existing = rows[0];
      if (existing) {
        if (existing.checksum !== checksum) {
          throw new Error(`Migration ${file} was modified after it was applied`);
        }
        return;
      }
      await tx.query(sql);
      await tx.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [file, checksum]);
      applied.push(file);
    });
  }
  await lockDownPublicSchema(db);
  return applied;
}

/**
 * Keeps this database private to the API. Hosted platforms such as Supabase expose the `public` schema over a REST
 * interface to their public client roles (`anon`, `authenticated`); a table with no row-level security and default
 * grants would then be readable and writable by anyone holding the public key. So, every time migrations run:
 * row-level security is switched on for every table (the API connects as the table owner, which RLS does not
 * restrict, so nothing changes for it), the public roles lose every privilege, and new objects start without them.
 * Safe on a plain PostgreSQL where those roles do not exist.
 */
export async function lockDownPublicSchema(db: Db): Promise<void> {
  await withTx(db, async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(727274)');
    await tx.query(`DO $$
    DECLARE t record; r record;
    BEGIN
      FOR t IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relrowsecurity LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.relname);
      END LOOP;
      FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated') LOOP
        EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r.rolname);
        EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', r.rolname);
        EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM %I', r.rolname);
        EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', r.rolname);
        EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', r.rolname);
        EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I', r.rolname);
      END LOOP;
    END $$`);
  });
}
