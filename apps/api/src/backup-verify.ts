import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import type { Db } from './db.js';
import { MIGRATIONS_DIR } from './migrate.js';

export interface Check { name: string; ok: boolean; detail: string }
export interface Verification { ok: boolean; checks: Check[]; counts: Record<string, number> }

const COUNTED = ['organizations', 'users', 'customers', 'products', 'product_variants', 'sales_orders', 'pos_sales', 'journal_entries', 'stock_movements', 'audit_log'];

/**
 * Looks inside a restored copy of the database and says whether it is whole: the schema is the one the code expects, the
 * books balance, stock is not negative and what customers paid agrees with the payments recorded. A backup that has never
 * passed this has not been proved to be a backup. Read-only.
 */
export async function verifyDatabase(db: Pick<Db, 'query'>, dir = MIGRATIONS_DIR): Promise<Verification> {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const applied = new Map((await db.query<{ name: string; checksum: string }>('SELECT name, checksum FROM schema_migrations')).rows.map((r) => [r.name, r.checksum]));
  const changed: string[] = [];
  for (const f of files) {
    const sum = applied.get(f);
    if (sum !== undefined && sum !== createHash('sha256').update(await readFile(`${dir}/${f}`, 'utf8')).digest('hex')) changed.push(f);
  }
  const unknown = [...applied.keys()].filter((n) => !files.includes(n));
  const behind = files.filter((f) => !applied.has(f));
  add('schema', changed.length === 0 && unknown.length === 0, changed.length || unknown.length
    ? `migrations differ from the code: changed ${changed.join(', ') || 'none'}; unknown ${unknown.join(', ') || 'none'}`
    : `${applied.size} migrations, all matching the code${behind.length ? `; ${behind.length} newer ones not yet applied (they apply on the next release)` : ''}`);

  const unbalanced = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM (
       SELECT entry_id FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE e.status = 'posted'
        GROUP BY entry_id HAVING sum(COALESCE(functional_debit_minor, 0)) <> sum(COALESCE(functional_credit_minor, 0))) x`,
  );
  add('books', unbalanced.rows[0]!.n === '0', unbalanced.rows[0]!.n === '0' ? 'every posted journal entry balances' : `${unbalanced.rows[0]!.n} posted journal entries do not balance`);

  const badStock = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM stock_balances WHERE quantity < 0 OR reserved < 0 OR reserved > quantity`);
  add('stock', badStock.rows[0]!.n === '0', badStock.rows[0]!.n === '0' ? 'no negative or over-reserved stock' : `${badStock.rows[0]!.n} stock balances are negative or over-reserved`);

  const badPaid = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM sales_orders o
      WHERE o.paid_minor <> COALESCE((SELECT sum(amount_minor) FROM sales_order_payments p WHERE p.order_id = o.id), 0)`,
  );
  add('payments', badPaid.rows[0]!.n === '0', badPaid.rows[0]!.n === '0' ? 'what each online order has paid agrees with its recorded payments' : `${badPaid.rows[0]!.n} online orders disagree with their recorded payments`);

  const orphanLines = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM sales_order_lines l WHERE NOT EXISTS (SELECT 1 FROM sales_orders o WHERE o.id = l.order_id)`);
  add('orders', orphanLines.rows[0]!.n === '0', orphanLines.rows[0]!.n === '0' ? 'every order line belongs to an order' : `${orphanLines.rows[0]!.n} order lines have no order`);

  const counts: Record<string, number> = {};
  for (const t of COUNTED) {
    const r = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${t}`).catch(() => null);
    if (r) counts[t] = Number(r.rows[0]!.n);
  }
  return { ok: checks.every((c) => c.ok), checks, counts };
}
