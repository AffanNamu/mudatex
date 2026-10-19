import { randomUUID } from 'node:crypto';
import { writeAudit } from '../../audit.js';
import { withTx, type Db, type Tx } from '../../db.js';
import { postMovements, type Posting } from '../../inventory/ledger.js';
import type { ImportConfig } from './config.js';
import { checksumOf, mapProduct, skuFor, type Issue } from './products.js';
import { ARCHIVED_COLLECTIONS, EXCLUDED_COLLECTIONS, scrubDocument } from './scrub.js';
import { docId, type Doc, type SourceData } from './source.js';

export interface ImportOptions {
  /** Run everything, report, then roll back so nothing is written. */
  dryRun: boolean;
  /** Re-apply products whose source data changed since the last import. Otherwise they are reported only. */
  updateChanged: boolean;
}

export interface Exception extends Issue {
  collection: string;
  sourceId: string;
}

export interface CollectionReport {
  source: number;
  created: number;
  updated: number;
  unchanged: number;
  changedNotApplied?: number;
  failed: number;
  note?: string;
}

export interface ImportReport {
  runId: string;
  dryRun: boolean;
  collections: Record<string, CollectionReport>;
  openingStock: { products: number; pieces: number };
  notMigrated: Record<string, string>;
  exceptions: Exception[];
}

class DryRunDone extends Error {
  constructor(readonly report: ImportReport) { super('dry run'); }
}

const CHUNK = 500;
const chunks = <T>(a: T[], n = CHUNK) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, (i + 1) * n));

export async function runImport(db: Db, cfg: ImportConfig, data: SourceData, present: string[], opts: ImportOptions): Promise<ImportReport> {
  try {
    return await withTx(db, async (tx) => {
      const report = await apply(tx, cfg, data, present, opts);
      if (opts.dryRun) throw new DryRunDone(report);
      return report;
    });
  } catch (err) {
    if (err instanceof DryRunDone) return err.report;
    throw err;
  }
}

async function apply(tx: Tx, cfg: ImportConfig, data: SourceData, present: string[], opts: ImportOptions): Promise<ImportReport> {
  const actor = await tx.query<{ id: string; organization_id: string }>(`SELECT id, organization_id FROM users WHERE email = $1 AND status = 'active'`, [cfg.actorEmail]);
  if (!actor.rows[0]) throw new Error(`No active user with email ${cfg.actorEmail}`);
  const { id: actorId, organization_id: orgId } = actor.rows[0];

  const loc = await tx.query<{ type: string }>(
    `SELECT l.type FROM locations l JOIN legal_entities e ON e.id = l.legal_entity_id WHERE l.id = $1 AND l.legal_entity_id = $2 AND e.organization_id = $3`,
    [cfg.locationId, cfg.legalEntityId, orgId],
  );
  if (!loc.rows[0]) throw new Error('locationId does not belong to legalEntityId in the actor\'s organization');
  if (!['branch', 'warehouse', 'storage_location'].includes(loc.rows[0].type)) throw new Error(`A ${loc.rows[0].type} location cannot hold stock`);
  if (cfg.priceListId) {
    const pl = await tx.query('SELECT 1 FROM price_lists WHERE id = $1 AND legal_entity_id = $2', [cfg.priceListId, cfg.legalEntityId]);
    if (!pl.rowCount) throw new Error('priceListId does not belong to legalEntityId');
  }

  const run = await tx.query<{ id: string }>(`INSERT INTO legacy_import_runs (organization_id, source_system, started_by, options) VALUES ($1,$2,$3,$4) RETURNING id`, [orgId, cfg.sourceSystem, actorId, JSON.stringify(opts)]);
  const runId = run.rows[0]!.id;
  const exceptions: Exception[] = [];
  const addIssues = (collection: string, sourceId: string, issues: Issue[]) => issues.forEach((i) => exceptions.push({ ...i, collection, sourceId }));
  const report: ImportReport = { runId, dryRun: opts.dryRun, collections: {}, openingStock: { products: 0, pieces: 0 }, notMigrated: {}, exceptions };

  // ---- unit ----
  const u = cfg.baseUnit;
  let unit = (await tx.query<{ id: string }>('SELECT id FROM units WHERE organization_id = $1 AND code = $2', [orgId, u.code])).rows[0]?.id;
  if (!unit) unit = (await tx.query<{ id: string }>('INSERT INTO units (organization_id, code, name, kind, precision) VALUES ($1,$2,$3,$4,$5) RETURNING id', [orgId, u.code, u.name, u.kind, u.precision])).rows[0]!.id;

  // ---- products ----
  const pr: CollectionReport = { source: (data.products ?? []).length, created: 0, updated: 0, unchanged: 0, changedNotApplied: 0, failed: 0 };
  report.collections.products = pr;
  const existing = new Map((await tx.query<{ source_id: string; target_id: string; checksum: string; meta: { variantId: string; openingStockPosted?: boolean } }>(
    `SELECT source_id, target_id, checksum, meta FROM legacy_mappings WHERE organization_id = $1 AND source_system = $2 AND source_collection = 'products'`, [orgId, cfg.sourceSystem])).rows.map((r) => [r.source_id, r]));
  const seen = new Set<string>();
  const stockPostings: Posting[] = [];

  for (const raw of data.products ?? []) {
    const id = docId(raw);
    if (!id) { pr.failed++; addIssues('products', '(no id)', [{ severity: 'error', code: 'missing_id', message: 'The document has no id' }]); continue; }
    if (seen.has(id)) { pr.failed++; addIssues('products', id, [{ severity: 'error', code: 'duplicate_id', message: 'The id appears more than once in the export; the first was used' }]); continue; }
    seen.add(id);
    const { product, issues } = mapProduct(id, raw);
    addIssues('products', id, issues);
    if (!product) { pr.failed++; continue; }

    const have = existing.get(id);
    if (have) {
      if (have.checksum === product.checksum) { pr.unchanged++; continue; }
      if (!opts.updateChanged) {
        pr.changedNotApplied!++;
        addIssues('products', id, [{ severity: 'info', code: 'source_changed', message: 'Changed in Sakash since the last import; not applied (use --update-changed)' }]);
        continue;
      }
      await tx.query(`UPDATE products SET name = $2, description = $3, category = $4, attributes = $5, updated_at = now() WHERE id = $1`, [have.target_id, product.name, product.description || null, product.category, JSON.stringify(product.attributes)]);
      await setPrice(tx, cfg, have.meta.variantId, product.unitPrice);
      let posted = have.meta.openingStockPosted === true;
      if (!posted && product.stock && product.stock > 0) {
        stockPostings.push({ locationId: cfg.locationId, variantId: have.meta.variantId, lotId: null, state: 'on_hand', delta: String(product.stock), type: 'receipt' });
        posted = true; report.openingStock.products++; report.openingStock.pieces += product.stock;
      }
      await tx.query(`UPDATE legacy_mappings SET checksum = $4, last_run_id = $5, meta = $6 WHERE organization_id = $1 AND source_system = $2 AND source_collection = 'products' AND source_id = $3`,
        [orgId, cfg.sourceSystem, id, product.checksum, runId, JSON.stringify({ ...have.meta, openingStockPosted: posted })]);
      pr.updated++;
      continue;
    }

    // New product. If the generated SKU is taken, disambiguate deterministically.
    let sku = product.sku;
    const clash = await tx.query('SELECT 1 FROM product_variants WHERE organization_id = $1 AND sku = $2', [orgId, sku]);
    if (clash.rowCount) sku = `${skuFor(id)}-${checksumOf(id).slice(0, 6).toUpperCase()}`;
    const p = await tx.query<{ id: string }>(
      `INSERT INTO products (organization_id, name, description, category, base_unit_id, attributes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [orgId, product.name, product.description || null, product.category, unit, JSON.stringify(product.attributes)],
    );
    const v = await tx.query<{ id: string }>(`INSERT INTO product_variants (organization_id, product_id, sku, attributes) VALUES ($1,$2,$3,$4) RETURNING id`, [orgId, p.rows[0]!.id, sku, JSON.stringify({ legacySourceId: id })]);
    const variantId = v.rows[0]!.id;
    await setPrice(tx, cfg, variantId, product.unitPrice);
    let posted = false;
    if (product.stock && product.stock > 0) {
      stockPostings.push({ locationId: cfg.locationId, variantId, lotId: null, state: 'on_hand', delta: String(product.stock), type: 'receipt' });
      posted = true; report.openingStock.products++; report.openingStock.pieces += product.stock;
    }
    await tx.query(
      `INSERT INTO legacy_mappings (organization_id, source_system, source_collection, source_id, target_type, target_id, checksum, meta, first_run_id, last_run_id)
       VALUES ($1,$2,'products',$3,'product',$4,$5,$6,$7,$7)`,
      [orgId, cfg.sourceSystem, id, p.rows[0]!.id, product.checksum, JSON.stringify({ variantId, sku, openingStockPosted: posted }), runId],
    );
    pr.created++;
  }
  // Opening balances go in as ordinary receipts so the stock ledger, not a side table, is the record of them.
  for (const part of chunks(stockPostings, 200)) {
    await postMovements(tx, { organizationId: orgId, actorUserId: actorId, reason: 'Sakash opening balance', referenceType: 'migration', referenceId: runId }, part);
  }

  // ---- categories: names travel on each product ----
  if (data.categories) report.collections.categories = { source: data.categories.length, created: 0, updated: 0, unchanged: 0, failed: 0, note: 'Not imported: each product carries its category name.' };

  // ---- read-only archive ----
  for (const c of ARCHIVED_COLLECTIONS) {
    const docs = data[c];
    if (!docs) continue;
    const cr: CollectionReport = { source: docs.length, created: 0, updated: 0, unchanged: 0, failed: 0 };
    report.collections[c] = cr;
    const have = new Map((await tx.query<{ source_id: string; checksum: string; target_id: string }>(
      `SELECT source_id, checksum, target_id FROM legacy_mappings WHERE organization_id = $1 AND source_system = $2 AND source_collection = $3`, [orgId, cfg.sourceSystem, c])).rows.map((r) => [r.source_id, r]));
    const ids = new Set<string>();
    const fresh: { id: string; sourceId: string; payload: unknown; amount: number | null; at: string | null; checksum: string }[] = [];
    const changed: typeof fresh = [];
    for (const d of docs as Doc[]) {
      const sid = docId(d);
      if (!sid) { cr.failed++; addIssues(c, '(no id)', [{ severity: 'error', code: 'missing_id', message: 'The document has no id' }]); continue; }
      if (ids.has(sid)) { cr.failed++; addIssues(c, sid, [{ severity: 'error', code: 'duplicate_id', message: 'The id appears more than once in the export; the first was used' }]); continue; }
      ids.add(sid);
      const s = scrubDocument(c, d);
      if (s.amount === null) addIssues(c, sid, [{ severity: 'warning', code: 'missing_amount', message: 'No usable total; archived without an amount' }]);
      const checksum = checksumOf(s.payload);
      const prev = have.get(sid);
      if (prev) {
        if (prev.checksum === checksum) cr.unchanged++;
        else changed.push({ id: prev.target_id, sourceId: sid, payload: s.payload, amount: s.amount, at: s.sourceCreatedAt, checksum });
      } else fresh.push({ id: randomUUID(), sourceId: sid, payload: s.payload, amount: s.amount, at: s.sourceCreatedAt, checksum });
    }
    for (const part of chunks(fresh)) {
      await tx.query(
        `INSERT INTO legacy_documents (id, organization_id, source_system, source_collection, source_id, payload, amount, source_created_at, checksum, run_id)
         SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::text[], $4::text[], $5::text[], $6::jsonb[], $7::numeric[], $8::timestamptz[], $9::text[], $10::uuid[])`,
        [part.map((x) => x.id), part.map(() => orgId), part.map(() => cfg.sourceSystem), part.map(() => c), part.map((x) => x.sourceId), part.map((x) => JSON.stringify(x.payload)),
         part.map((x) => x.amount), part.map((x) => x.at), part.map((x) => x.checksum), part.map(() => runId)],
      );
      await tx.query(
        `INSERT INTO legacy_mappings (organization_id, source_system, source_collection, source_id, target_type, target_id, checksum, first_run_id, last_run_id)
         SELECT $1, $2, $3, s, 'document', t, k, $4, $4 FROM unnest($5::text[], $6::uuid[], $7::text[]) AS x(s, t, k)`,
        [orgId, cfg.sourceSystem, c, runId, part.map((x) => x.sourceId), part.map((x) => x.id), part.map((x) => x.checksum)],
      );
      cr.created += part.length;
    }
    for (const x of changed) {
      await tx.query(`UPDATE legacy_documents SET payload = $2, amount = $3, source_created_at = $4, checksum = $5, run_id = $6, imported_at = now() WHERE id = $1`, [x.id, JSON.stringify(x.payload), x.amount, x.at, x.checksum, runId]);
      await tx.query(`UPDATE legacy_mappings SET checksum = $5, last_run_id = $6 WHERE organization_id = $1 AND source_system = $2 AND source_collection = $3 AND source_id = $4`, [orgId, cfg.sourceSystem, c, x.sourceId, x.checksum, runId]);
      cr.updated++;
    }
  }

  for (const c of present) if (c in EXCLUDED_COLLECTIONS) report.notMigrated[c] = EXCLUDED_COLLECTIONS[c]!;

  // ---- record the exception register and the run ----
  for (const part of chunks(exceptions)) {
    await tx.query(
      `INSERT INTO legacy_import_exceptions (run_id, source_collection, source_id, severity, code, message)
       SELECT $1, * FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[])`,
      [runId, part.map((e) => e.collection), part.map((e) => e.sourceId), part.map((e) => e.severity), part.map((e) => e.code), part.map((e) => e.message)],
    );
  }
  await tx.query(`UPDATE legacy_import_runs SET finished_at = now(), summary = $2 WHERE id = $1`, [runId, JSON.stringify({ collections: report.collections, openingStock: report.openingStock, exceptions: exceptions.length })]);
  await writeAudit(tx, { organizationId: orgId, actorUserId: actorId, action: 'migration.run', entityType: 'legacy_import_run', entityId: runId, after: { source: cfg.sourceSystem, collections: report.collections } });
  return report;
}

/** Sets the price from now on, closing the current open price. No-op when unchanged or no price list is configured. */
async function setPrice(tx: Tx, cfg: ImportConfig, variantId: string, unitPrice: string): Promise<void> {
  if (!cfg.priceListId) return;
  const open = await tx.query<{ id: string; unit_price: string }>('SELECT id, unit_price FROM price_list_items WHERE price_list_id = $1 AND variant_id = $2 AND effective_to IS NULL FOR UPDATE', [cfg.priceListId, variantId]);
  if (open.rows[0]) {
    if (Number(open.rows[0].unit_price) === Number(unitPrice)) return;
    await tx.query('UPDATE price_list_items SET effective_to = clock_timestamp() WHERE id = $1', [open.rows[0].id]);
  }
  await tx.query('INSERT INTO price_list_items (price_list_id, variant_id, unit_price, effective_from) VALUES ($1,$2,$3, clock_timestamp())', [cfg.priceListId, variantId, unitPrice]);
}
