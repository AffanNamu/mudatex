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
  return applied;
}
