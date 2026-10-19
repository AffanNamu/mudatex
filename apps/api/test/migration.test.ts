import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { importConfig, type ImportConfig } from '../src/migration/sakash/config.js';
import { runImport } from '../src/migration/sakash/importer.js';
import { profile } from '../src/migration/sakash/profile.js';
import { mapProduct } from '../src/migration/sakash/products.js';
import { reconcile } from '../src/migration/sakash/reconcile.js';
import { normalizeTimestamp, scrubDocument } from '../src/migration/sakash/scrub.js';
import { readExport, type SourceData } from '../src/migration/sakash/source.js';
import { call, newOrg, setupApp } from './helpers.js';
import { buildWorld, balance } from './inventory-helpers.js';
import { PII, syntheticSakash } from './fixtures/sakash.js';

let ctx: Awaited<ReturnType<typeof setupApp>>;
beforeAll(async () => { ctx = await setupApp(); });
afterAll(async () => { await ctx.close(); });

async function target(withPriceList = true) {
  const w = await buildWorld(ctx.app, await newOrg(ctx.db));
  let priceListId: string | undefined;
  if (withPriceList) priceListId = (await call(ctx.app, 'POST', '/v1/pricing/price-lists', w.org.auth, { legalEntityId: w.ng, name: 'Retail', currency: 'NGN' })).body.id;
  const cfg: ImportConfig = importConfig.parse({ actorEmail: `${w.org.sub}@example.test`, legalEntityId: w.ng, locationId: w.w1, priceListId, baseUnit: { code: 'pc', name: 'Piece' } });
  return { w, cfg, priceListId };
}
const count = async (table: string, org: string, col = 'organization_id') => Number((await ctx.db.query(`SELECT count(*) AS n FROM ${table} WHERE ${col} = $1`, [org])).rows[0].n);
const clone = (d: SourceData): SourceData => JSON.parse(JSON.stringify(d));
const imp = (t: Awaited<ReturnType<typeof target>>, d: ReturnType<typeof syntheticSakash>, o: { dryRun?: boolean; updateChanged?: boolean } = {}) =>
  runImport(ctx.db, t.cfg, d.data, d.present, { dryRun: o.dryRun ?? false, updateChanged: o.updateChanged ?? false });

describe('profiling', () => {
  it('describes the export and what is wrong with it, before anything is imported', () => {
    const { data, present } = syntheticSakash();
    const p = profile(data, present) as any;
    expect(p.products).toMatchObject({ records: 36, importable: 31, missingId: 1, duplicateIds: 1, openingStockPieces: 562, zeroPriced: 1 });
    expect(p.products.issues).toEqual({ missing_name: 1, invalid_price: 2, negative_stock: 1, fractional_stock: 1, flagged_out_of_stock: 1 });
    expect(p.documents.pos_sales).toMatchObject({ records: 13, archivable: 12, duplicateIds: 1, totalAmount: 61266 });
    expect(p.documents.orders).toMatchObject({ records: 9, archivable: 8, missingId: 1, totalAmount: 32800 });
    expect(p.documents.pos_receipts).toMatchObject({ archivable: 2, missingAmount: 1, totalAmount: 5100 });
    expect(Object.keys(p.notMigrated).sort()).toEqual(['admins', 'app_settings', 'payment_attempts', 'users']);
    expect(p.unknownCollections).toEqual(['mystery_collection']);
    // the privacy view: which fields would be dropped, and how often
    expect(p.documents.pos_sales.droppedFields).toMatchObject({ customerName: 12, customerPhone: 12, cashierEmail: 12 });
    expect(p.documents.orders.droppedFields).toMatchObject({ userId: 8, deliveryAddress: 8, fcmToken: 8, notes: 8 });
  });
});

describe('field filtering', () => {
  it('lets only allow-listed fields through, including inside nested items', () => {
    const { data } = syntheticSakash();
    for (const c of ['pos_sales', 'orders', 'pos_receipts', 'payments'] as const) {
      for (const d of data[c]!) {
        const out = JSON.stringify(scrubDocument(c, d).payload);
        for (const secret of PII) expect(out).not.toContain(secret);
      }
    }
    const sale = scrubDocument('pos_sales', data.pos_sales![0]!);
    expect(sale.payload.items).toEqual([{ productId: 'prod0001', name: 'Ankara Wax Print 1', quantity: 2, price: 2550 }]);   // imageUrl and internalNote dropped
    expect(sale.amount).toBe(5100);
    expect(Object.keys(sale.payload)).not.toContain('customerName');
  });

  it('understands Firestore timestamps in several shapes', () => {
    expect(normalizeTimestamp('2025-03-01T09:30:00Z')).toBe('2025-03-01T09:30:00.000Z');
    expect(normalizeTimestamp({ _seconds: 1741000000 })).toBe('2025-03-03T11:06:40.000Z');
    expect(normalizeTimestamp({ seconds: 1741000000 })).toBe('2025-03-03T11:06:40.000Z');
    expect(normalizeTimestamp(1741000000)).toBe('2025-03-03T11:06:40.000Z');
    expect(normalizeTimestamp(1741000000000)).toBe('2025-03-03T11:06:40.000Z');
    expect(normalizeTimestamp('not a date')).toBeNull();
    expect(normalizeTimestamp(null)).toBeNull();
  });

  it('maps a product to exact decimals and a stable checksum', () => {
    const a = mapProduct('p1', { name: ' Lace ', price: 1999.99, stockQuantity: 3, availableColors: ['Red', ' '] });
    expect(a.product).toMatchObject({ name: 'Lace', unitPrice: '1999.9900', stock: 3, sku: 'SAK-P1' });
    expect(a.product!.attributes.colors).toEqual(['Red']);
    expect(mapProduct('p1', { name: 'Lace', price: 1999.99, stockQuantity: 3, availableColors: ['Red'] }).product!.checksum).toBe(a.product!.checksum);
    expect(mapProduct('p1', { name: 'Lace', price: 2000, stockQuantity: 3, availableColors: ['Red'] }).product!.checksum).not.toBe(a.product!.checksum);
  });
});

describe('plan (dry run)', () => {
  it('reports everything and writes nothing', async () => {
    const t = await target();
    const org = t.w.org.organizationId;
    const tables = ['products', 'product_variants', 'legacy_mappings', 'legacy_documents', 'legacy_import_runs', 'stock_movements', 'units', 'audit_log'];
    const before = Object.fromEntries(await Promise.all(tables.map(async (x) => [x, await count(x, org)])));
    const report = await imp(t, syntheticSakash(), { dryRun: true });
    expect(report.dryRun).toBe(true);
    expect(report.collections.products).toMatchObject({ source: 36, created: 31, failed: 5 });
    const after = Object.fromEntries(await Promise.all(tables.map(async (x) => [x, await count(x, org)])));
    expect(after).toEqual(before);                                                           // not one row written, not even the run record or the unit
  });
});

describe('import', () => {
  it('creates products, prices, opening stock and a read-only archive, and accounts for every record', async () => {
    const t = await target();
    const org = t.w.org.organizationId;
    const src = syntheticSakash();
    const r = await imp(t, src);

    expect(r.collections.products).toEqual({ source: 36, created: 31, updated: 0, unchanged: 0, changedNotApplied: 0, failed: 5 });
    expect(r.collections.pos_sales).toMatchObject({ source: 13, created: 12, failed: 1 });
    expect(r.collections.orders).toMatchObject({ source: 9, created: 8, failed: 1 });
    expect(r.collections.pos_receipts).toMatchObject({ source: 2, created: 2 });
    expect(r.collections.payments).toMatchObject({ source: 1, created: 1 });
    expect(r.collections.categories).toMatchObject({ source: 2, created: 0 });
    expect(r.openingStock).toEqual({ products: 28, pieces: 562 });
    expect(r.exceptions).toHaveLength(11);
    expect(Object.keys(r.notMigrated).sort()).toEqual(['admins', 'app_settings', 'payment_attempts', 'users']);
    // every source record is either imported or in the exception register
    for (const [name, c] of Object.entries(r.collections)) if (name !== 'categories') expect(c.created + c.updated + c.unchanged + c.failed + (c.changedNotApplied ?? 0)).toBe(c.source);

    const reg = await ctx.db.query(`SELECT severity, count(*)::int AS n FROM legacy_import_exceptions WHERE run_id = $1 GROUP BY severity ORDER BY severity`, [r.runId]);
    expect(reg.rows).toEqual([{ severity: 'error', n: 7 }, { severity: 'info', n: 1 }, { severity: 'warning', n: 3 }]);

    // catalogue
    const prods = await call(ctx.app, 'GET', '/v1/products?limit=200', t.w.org.auth);
    prods.body = prods.body.filter((p: any) => p.attributes?.legacy === true);               // the test world has three products of its own
    expect(prods.body).toHaveLength(31);
    const one = prods.body.find((p: any) => p.name === 'Ankara Wax Print 3');
    expect(one.variants[0].sku).toBe('SAK-PROD0003');
    expect(one.attributes).toMatchObject({ legacy: true, fabricType: 'Cotton', colors: ['Red', 'Blue'], yardage: 6, categories: ['Fabrics', 'Ankara'] });
    expect(one.category).toBe('Ankara');
    const units = await call(ctx.app, 'GET', '/v1/units', t.w.org.auth);
    expect(units.body.find((u: any) => u.code === 'pc')).toMatchObject({ kind: 'discrete', precision: 0 });

    // price list
    const prices = await call(ctx.app, 'GET', `/v1/pricing/price-lists/${t.priceListId}/items`, t.w.org.auth);
    expect(prices.body).toHaveLength(31);
    expect(prices.body.filter((p: any) => p.unitPrice === '1500').length).toBe(1);        // "1500" given as a string
    expect(prices.body.filter((p: any) => p.unitPrice === '2500.5').length).toBe(1);      // fractional price kept exactly

    // opening stock is in the ledger, as receipts, and the ledger is consistent
    const variant = one.variants[0].id;
    expect((await balance(ctx.app, t.w.org.auth, { locationId: t.w.w1, variantId: variant })).quantity).toBe('13');
    const moves = await call(ctx.app, 'GET', `/v1/inventory/movements?referenceType=migration&referenceId=${r.runId}&limit=200`, t.w.org.auth);
    expect(moves.body).toHaveLength(28);
    expect(moves.body.every((m: any) => m.type === 'receipt' && m.reason === 'Sakash opening balance')).toBe(true);
    expect((await call(ctx.app, 'GET', '/v1/inventory/reconciliation', t.w.org.auth)).body.consistent).toBe(true);
    // products with unusable stock were imported without any
    const neg = prods.body.find((p: any) => p.name === 'Negative stock');
    expect((await balance(ctx.app, t.w.org.auth, { locationId: t.w.w1, variantId: neg.variants[0].id })).quantity).toBe('0');

    // archive: filtered, with totals, and traceable
    const docs = await ctx.db.query(`SELECT source_collection, count(*)::int AS n, sum(amount)::text AS total FROM legacy_documents WHERE organization_id = $1 GROUP BY 1 ORDER BY 1`, [org]);
    expect(docs.rows).toEqual([
      { source_collection: 'orders', n: 8, total: '32800.0000' }, { source_collection: 'payments', n: 1, total: '4100.0000' },
      { source_collection: 'pos_receipts', n: 2, total: '5100.0000' }, { source_collection: 'pos_sales', n: 12, total: '61266.0000' },
    ]);
    const stored = JSON.stringify((await ctx.db.query('SELECT payload FROM legacy_documents WHERE organization_id = $1', [org])).rows);
    for (const secret of PII) expect(stored).not.toContain(secret);
    expect(await count('legacy_mappings', org)).toBe(31 + 12 + 8 + 2 + 1);
    const timestamps = await ctx.db.query(`SELECT source_created_at FROM legacy_documents WHERE organization_id = $1 AND source_id = 'sale0001'`, [org]);
    expect(timestamps.rows[0].source_created_at.toISOString()).toBe('2025-03-03T12:06:40.000Z');          // {_seconds} form

    // the first record with a duplicated id wins
    const first = await ctx.db.query(`SELECT amount::text FROM legacy_documents WHERE organization_id = $1 AND source_id = 'sale0000'`, [org]);
    expect(first.rows[0].amount).toBe('5100.0000');

    const rec = await reconcile(ctx.db, t.cfg, src.data);
    expect(rec.checks.filter((c) => !c.ok)).toEqual([]);
    expect(rec.matched).toBe(true);
    expect(rec.checks.find((c) => c.name === 'opening stock (pieces)')).toMatchObject({ expected: 562, actual: 562 });
  });

  it('is safe to repeat: a second run changes nothing', async () => {
    const t = await target();
    const org = t.w.org.organizationId;
    const src = syntheticSakash();
    await imp(t, src);
    const before = { products: await count('products', org), mappings: await count('legacy_mappings', org), docs: await count('legacy_documents', org), moves: await count('stock_movements', org) };
    const again = await imp(t, src);
    expect(again.collections.products).toMatchObject({ created: 0, updated: 0, unchanged: 31, failed: 5 });
    expect(again.collections.pos_sales).toMatchObject({ created: 0, unchanged: 12 });
    expect(again.openingStock).toEqual({ products: 0, pieces: 0 });
    expect({ products: await count('products', org), mappings: await count('legacy_mappings', org), docs: await count('legacy_documents', org), moves: await count('stock_movements', org) }).toEqual(before);
    expect((await reconcile(ctx.db, t.cfg, src.data)).matched).toBe(true);
    expect(await count('legacy_import_runs', org)).toBe(2);                                        // each run is recorded
  });

  it('two runs at the same time cannot duplicate anything', async () => {
    const t = await target();
    const org = t.w.org.organizationId;
    const src = syntheticSakash({ products: 8, sales: 4 });
    const results = await Promise.allSettled([imp(t, src), imp(t, src)]);
    expect(results.filter((r) => r.status === 'fulfilled').length).toBeGreaterThanOrEqual(1);
    expect(await count('products', org)).toBe(3 + 14);                                             // the world's 3, plus 8 + 6 imported once each
    expect((await reconcile(ctx.db, t.cfg, src.data)).matched).toBe(true);
  });

  it('reports source changes, and applies them only on request', async () => {
    const t = await target();
    const org = t.w.org.organizationId;
    const src = syntheticSakash();
    await imp(t, src);

    const next = clone(src.data);
    const p1 = next.products!.find((p) => p.id === 'prod0001')!;
    p1.name = 'Ankara Renamed'; p1.price = 3000;
    next.products!.find((p) => p.id === 'warn-negative')!.stockQuantity = 4;                       // data fixed in the source
    (next.pos_sales![1] as any).finalTotal = 7777;

    const held = await runImport(ctx.db, t.cfg, next, src.present, { dryRun: false, updateChanged: false });
    expect(held.collections.products).toMatchObject({ created: 0, updated: 0, changedNotApplied: 2 });
    expect(held.exceptions.filter((e) => e.code === 'source_changed')).toHaveLength(2);
    expect((await call(ctx.app, 'GET', '/v1/products?limit=200', t.w.org.auth)).body.some((p: any) => p.name === 'Ankara Renamed')).toBe(false);
    expect(held.collections.pos_sales).toMatchObject({ updated: 1 });                              // archive copies follow the source

    const applied = await runImport(ctx.db, t.cfg, next, src.present, { dryRun: false, updateChanged: true });
    expect(applied.collections.products).toMatchObject({ updated: 2, changedNotApplied: 0 });
    expect(applied.openingStock).toEqual({ products: 1, pieces: 4 });                              // the fixed stock is posted once
    const prods = (await call(ctx.app, 'GET', '/v1/products?limit=200', t.w.org.auth)).body;
    expect(prods.some((p: any) => p.name === 'Ankara Renamed')).toBe(true);
    const items = (await call(ctx.app, 'GET', `/v1/pricing/price-lists/${t.priceListId}/items`, t.w.org.auth)).body.filter((i: any) => i.variantId === prods.find((p: any) => p.name === 'Ankara Renamed').variants[0].id);
    expect(items.map((i: any) => i.unitPrice)).toEqual(['2550', '3000']);                          // old price closed, new one open
    expect(items[0].effectiveTo).not.toBeNull();
    expect(items[1].effectiveTo).toBeNull();

    const third = await runImport(ctx.db, t.cfg, next, src.present, { dryRun: false, updateChanged: true });
    expect(third.collections.products).toMatchObject({ updated: 0, unchanged: 31 });
    expect(third.openingStock.pieces).toBe(0);
    expect((await reconcile(ctx.db, t.cfg, next)).matched).toBe(true);
    expect(org).toBeTruthy();
  });

  it('disambiguates a SKU that is already taken', async () => {
    const t = await target(false);
    await call(ctx.app, 'POST', '/v1/units', t.w.org.auth, { code: 'x', name: 'x', kind: 'decimal', precision: 2 }).catch(() => {});
    const u = (await call(ctx.app, 'GET', '/v1/units', t.w.org.auth)).body[0].id;
    await call(ctx.app, 'POST', '/v1/products', t.w.org.auth, { name: 'Mine', baseUnitId: u, variants: [{ sku: 'SAK-PROD0000' }] });
    const r = await imp(t, syntheticSakash({ products: 2, sales: 1 }));
    expect(r.collections.products!.created).toBeGreaterThan(0);
    const skus = (await call(ctx.app, 'GET', '/v1/products?limit=200', t.w.org.auth)).body.flatMap((p: any) => p.variants.map((v: any) => v.sku));
    expect(new Set(skus).size).toBe(skus.length);
    expect(skus.filter((s: string) => s.startsWith('SAK-PROD0000')).sort()).toHaveLength(2);
    expect(skus.some((s: string) => /^SAK-PROD0000-[0-9A-F]{6}$/.test(s))).toBe(true);
  });

  it('works without a price list', async () => {
    const t = await target(false);
    const r = await imp(t, syntheticSakash({ products: 3, sales: 1 }));
    expect(r.collections.products!.created).toBeGreaterThan(0);
    expect((await ctx.db.query('SELECT count(*)::int AS n FROM price_list_items pi JOIN price_lists pl ON pl.id = pi.price_list_id WHERE pl.organization_id = $1', [t.w.org.organizationId])).rows[0].n).toBe(0);
  });
});

describe('reconciliation', () => {
  it('detects missing records, altered totals, broken links and a different export', async () => {
    const t = await target();
    const org = t.w.org.organizationId;
    const src = syntheticSakash();
    await imp(t, src);
    expect((await reconcile(ctx.db, t.cfg, src.data)).matched).toBe(true);

    // 1. an export with a product that was never imported
    const more = clone(src.data);
    more.products!.push({ id: 'prod-new', name: 'Newly added upstream', price: 10, stockQuantity: 5 });
    const r1 = await reconcile(ctx.db, t.cfg, more);
    expect(r1.matched).toBe(false);
    expect(r1.checks.find((c) => c.name === 'products imported')).toMatchObject({ ok: false, expected: 32, actual: 31, detail: ['not imported: prod-new'] });
    expect(r1.checks.find((c) => c.name === 'opening stock (pieces)')).toMatchObject({ ok: false, expected: 567, actual: 562 });

    // 2. an archived total altered after the import
    await ctx.db.query(`UPDATE legacy_documents SET amount = amount + 1 WHERE organization_id = $1 AND source_id = 'order1'`, [org]);
    expect((await reconcile(ctx.db, t.cfg, src.data)).checks.find((c) => c.name === 'orders archived (total amount)')).toMatchObject({ ok: false, expected: '32800.0000', actual: '32801.0000' });
    await ctx.db.query(`UPDATE legacy_documents SET amount = amount - 1 WHERE organization_id = $1 AND source_id = 'order1'`, [org]);

    // 3. an archived document removed behind the mapping's back
    await ctx.db.query(`DELETE FROM legacy_documents WHERE organization_id = $1 AND source_id = 'pay1'`, [org]);
    const r3 = await reconcile(ctx.db, t.cfg, src.data);
    expect(r3.checks.filter((c) => !c.ok).map((c) => c.name).sort()).toEqual(['mappings pointing at missing records', 'payments archived (count)', 'payments archived (total amount)']);
  });
});

describe('safety checks on the configuration', () => {
  it('refuses to start, and writes nothing, when the target is wrong', async () => {
    const t = await target();
    const org = t.w.org.organizationId;
    const src = syntheticSakash({ products: 2, sales: 1 });
    const run = (c: Partial<ImportConfig>) => runImport(ctx.db, { ...t.cfg, ...c }, src.data, src.present, { dryRun: false, updateChanged: false });
    await expect(run({ actorEmail: 'nobody@example.test' })).rejects.toThrow(/No active user/);
    await expect(run({ locationId: t.w.g1 })).rejects.toThrow(/does not belong/);                  // another legal entity's location
    await expect(run({ locationId: t.w.dept })).rejects.toThrow(/cannot hold stock/);
    const gh = (await call(ctx.app, 'POST', '/v1/pricing/price-lists', t.w.org.auth, { legalEntityId: t.w.gh, name: 'GH', currency: 'GHS' })).body.id;
    await expect(run({ priceListId: gh })).rejects.toThrow(/priceListId/);
    expect(await count('legacy_import_runs', org)).toBe(0);
    expect(await count('products', org)).toBe(3);                                                  // only the test world's own
    expect(() => importConfig.parse({ actorEmail: 'not-an-email', legalEntityId: t.w.ng, locationId: t.w.w1 })).toThrow();
  });
});

describe('reading an export', () => {
  it('reads ndjson and json files and names the line of a corrupt file', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'sakash-'));
    await writeFile(path.join(dir, 'products.ndjson'), '{"id":"a","name":"A"}\n\n{"id":"b","name":"B"}\n');
    await writeFile(path.join(dir, 'orders.json'), JSON.stringify([{ id: 'o1' }]));
    await writeFile(path.join(dir, 'users.ndjson'), '{"id":"u1","email":"private@example.com"}\n');
    await writeFile(path.join(dir, 'readme.txt'), 'ignore me');
    const { data, present } = await readExport(dir);
    expect(data.products).toHaveLength(2);
    expect(data.orders).toEqual([{ id: 'o1' }]);
    expect(data.users).toBeUndefined();                                                            // never even loaded
    expect(present).toEqual(['orders', 'products', 'users']);

    const bad = await mkdtemp(path.join(os.tmpdir(), 'sakash-'));
    await writeFile(path.join(bad, 'products.ndjson'), '{"id":"a"}\n{oops\n');
    await expect(readExport(bad)).rejects.toThrow(/products\.ndjson: line 2/);
    const notArray = await mkdtemp(path.join(os.tmpdir(), 'sakash-'));
    await writeFile(path.join(notArray, 'products.json'), '{"id":"a"}');
    await expect(readExport(notArray)).rejects.toThrow(/expected an array/);
  });
});

describe('volume', () => {
  it('imports thousands of records in one run and still reconciles exactly', async () => {
    const t = await target();
    const src = syntheticSakash({ products: 2000, sales: 4000 });
    const started = Date.now();
    const r = await imp(t, src);
    const seconds = (Date.now() - started) / 1000;
    expect(r.collections.products!.created).toBe(2006);
    expect(r.collections.pos_sales).toMatchObject({ created: 4000, failed: 1 });
    expect(seconds).toBeLessThan(90);
    const rec = await reconcile(ctx.db, t.cfg, src.data);
    expect(rec.checks.filter((c) => !c.ok)).toEqual([]);
    expect((await call(ctx.app, 'GET', '/v1/inventory/reconciliation', t.w.org.auth)).body.consistent).toBe(true);
  }, 180_000);
});
