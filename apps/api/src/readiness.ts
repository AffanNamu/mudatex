import { readdir } from 'node:fs/promises';
import type { Db } from './db.js';
import { MIGRATIONS_DIR } from './migrate.js';

export interface Readiness {
  ready: boolean;
  database: boolean;
  pendingMigrations: string[];
}

export async function checkReadiness(db: Db, dir = MIGRATIONS_DIR): Promise<Readiness> {
  try {
    await db.query('SELECT 1');
  } catch {
    return { ready: false, database: false, pendingMigrations: [] };
  }
  try {
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    const { rows } = await db.query<{ name: string }>('SELECT name FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.name));
    const pending = files.filter((f) => !applied.has(f));
    return { ready: pending.length === 0, database: true, pendingMigrations: pending };
  } catch {
    return { ready: false, database: true, pendingMigrations: ['unknown'] };
  }
}
