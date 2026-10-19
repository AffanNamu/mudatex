import type { Db } from '../../db.js';
import type { ImportConfig } from './config.js';
import { mapProduct } from './products.js';
import { ARCHIVED_COLLECTIONS, scrubDocument } from './scrub.js';
import { docId, type SourceData } from './source.js';

export interface Check {
  name: string;
  expected: string | number;
  actual: string | number;
  ok: boolean;
  detail?: string[];
}

const scaled = (n: number) => BigInt(Math.round(n * 10000));
const fmt = (n: bigint) => `${n / 10000n}.${(n % 10000n).toString().padStart(4, '0')}`;

/**
 * Compares the export with what Mudatex holds: every importable product is mapped, opening stock equals the source
 * count, every archivable document is present with the same total, and every mapping still points at a real record.
 * Exact comparisons, no tolerance: a difference is a finding.
 */
export async function reconcile(db: Db, cfg: ImportConfig, data: SourceData): Promise<{ matched: boolean; checks: Check[] }> {
  const org = (await db.query<{ organization_id: string }>('SELECT organization_id FROM users WHERE email = $1', [cfg.actorEmail])).rows[0]?.organization_id;
  if (!org) throw new Error(`No user with email ${cfg.actorEmail}`);
  const checks: Check[] = [];
  const add = (name: string, expected: string | number, actual: string | number, detail?: string[]) =>
    checks.push({ name, expected, actual, ok: String(expected) === String(actual), ...(detail?.length ? { detail: detail.slice(0, 20) } : {}) });

  // products
  const wanted = new Map<string, number | null>();
  for (const p of data.products ?? []) {
    const id = docId(p);
    if (!id || wanted.has(id)) continue;
    const { product } = mapProduct(id, p);
    if (product) wanted.set(id, product.stock);
  }
  const mapped = await db.query<{ source_id: string; meta: { variantId: string; openingStockPosted?: boolean } }>(
    `SELECT source_id, meta FROM legacy_mappings WHERE organization_id = $1 AND source_system = $2 AND source_collection = 'products'`, [org, cfg.sourceSystem]);
  const have = new Map(mapped.rows.map((r) => [r.source_id, r.meta]));
  const missing = [...wanted.keys()].filter((id) => !have.has(id));
  add('products imported', wanted.size, wanted.size - missing.length, missing.map((id) => `not imported: ${id}`));

  // opening stock: source counts against the migration receipts, never against live stock (which changes after cutover)
  const expectedStock = [...wanted.entries()].reduce((a, [, s]) => a + (s ?? 0), 0);
  const variantIds = [...have.values()].map((m) => m.variantId);
  const posted = await db.query<{ q: string | null }>(
    `SELECT sum(quantity) AS q FROM stock_movements WHERE organization_id = $1 AND reference_type = 'migration' AND location_id = $2 AND variant_id = ANY($3::uuid[]) AND movement_type = 'receipt'`,
    [org, cfg.locationId, variantIds],
  );
  add('opening stock (pieces)', expectedStock, Number(posted.rows[0]?.q ?? 0));

  // archive: counts and totals per collection
  for (const c of ARCHIVED_COLLECTIONS) {
    if (!data[c]) continue;
    const seen = new Set<string>();
    let total = 0n;
    for (const d of data[c]!) {
      const id = docId(d);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const a = scrubDocument(c, d).amount;
      if (a !== null) total += scaled(a);
    }
    const r = await db.query<{ n: string; t: string | null }>(
      `SELECT count(*) AS n, COALESCE(sum(amount), 0)::text AS t FROM legacy_documents WHERE organization_id = $1 AND source_system = $2 AND source_collection = $3 AND source_id = ANY($4::text[])`,
      [org, cfg.sourceSystem, c, [...seen]],
    );
    add(`${c} archived (count)`, seen.size, Number(r.rows[0]!.n));
    add(`${c} archived (total amount)`, fmt(total), fmt(scaled(Number(r.rows[0]!.t))));
  }

  // every mapping still resolves
  const broken = await db.query<{ source_collection: string; source_id: string }>(
    `SELECT m.source_collection, m.source_id FROM legacy_mappings m
      WHERE m.organization_id = $1 AND m.source_system = $2
        AND NOT EXISTS (SELECT 1 FROM products p WHERE m.target_type = 'product' AND p.id = m.target_id)
        AND NOT EXISTS (SELECT 1 FROM legacy_documents d WHERE m.target_type = 'document' AND d.id = m.target_id)`,
    [org, cfg.sourceSystem],
  );
  add('mappings pointing at missing records', 0, broken.rowCount ?? 0, broken.rows.map((b) => `${b.source_collection}/${b.source_id}`));
  return { matched: checks.every((c) => c.ok), checks };
}
