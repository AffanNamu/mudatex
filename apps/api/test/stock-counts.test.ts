import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, newOrg, setupApp } from './helpers.js';
import { balance, buildWorld, cmd, receive, staff, type World } from './inventory-helpers.js';

let ctx: Awaited<ReturnType<typeof setupApp>>;
beforeAll(async () => { ctx = await setupApp(); });
afterAll(async () => { await ctx.close(); });

const world = async () => buildWorld(ctx.app, await newOrg(ctx.db));
const count = (w: World, auth: any, body: Record<string, unknown>, key?: string) => cmd(ctx.app, auth, '/v1/inventory/counts', { locationId: w.w1, ...body }, key);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('stock counts', () => {
  it('records a matching count without asking anyone to approve anything', async () => {
    const w = await world();
    await receive(ctx.app, w.org.auth, w.w1, w.fabric.variantId, '40');
    const r = await count(w, w.org.auth, { lines: [{ variantId: w.fabric.variantId, counted: '40' }] });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ adjustmentId: null, matched: 1, differences: [] });
  });

  it('turns a difference into one pending adjustment that a second person approves', async () => {
    const w = await world();
    await receive(ctx.app, w.org.auth, w.w1, w.fabric.variantId, '40');
    const counter = await staff(ctx.app, w.org.auth, ['inventory.adjust', 'inventory.read'], { type: 'location', id: w.w1 });
    const r = await count(w, counter.auth, { note: 'Aisle 3', lines: [{ variantId: w.fabric.variantId, counted: '37.5' }] });
    expect(r.status).toBe(201);
    expect(r.body.differences).toEqual([expect.objectContaining({ counted: '37.5', expected: '40', delta: '-2.5', productName: 'Fabric' })]);
    // Nothing moved yet.
    expect((await balance(ctx.app, w.org.auth, { locationId: w.w1, variantId: w.fabric.variantId })).quantity).toBe('40');
    const adj = await call(ctx.app, 'GET', `/v1/inventory/adjustments/${r.body.adjustmentId}`, w.org.auth);
    expect(adj.body).toMatchObject({ status: 'pending', reason: expect.stringContaining('Aisle 3'), lines: [{ delta: '-2.5' }] });
    // The counter cannot approve their own count.
    const both = await staff(ctx.app, w.org.auth, ['inventory.adjust', 'inventory.adjust.approve'], { type: 'location', id: w.w1 });
    expect((await cmd(ctx.app, counter.auth, `/v1/inventory/adjustments/${r.body.adjustmentId}/approve`, {})).status).toBe(403);
    expect((await cmd(ctx.app, both.auth, `/v1/inventory/adjustments/${r.body.adjustmentId}/approve`, {})).status).toBe(200);
    expect((await balance(ctx.app, w.org.auth, { locationId: w.w1, variantId: w.fabric.variantId })).quantity).toBe('37.5');
    const list = await call(ctx.app, 'GET', `/v1/inventory/counts?locationId=${w.w1}`, counter.auth);
    expect(list.body[0]).toMatchObject({ id: r.body.id, adjustmentStatus: 'approved', lines: 1, note: 'Aisle 3' });
  });

  it('compares against what the books said when the shelf was counted, so a late upload is still right', async () => {
    const w = await world();
    await receive(ctx.app, w.org.auth, w.w1, w.fabric.variantId, '10');
    await wait(60);
    const countedAt = new Date().toISOString();
    await wait(60);
    // A sale at the till after the count was taken but before it reached the server.
    const out = await cmd(ctx.app, w.org.auth, '/v1/inventory/issues', { locationId: w.w1, reasonCode: 'sale', lines: [{ variantId: w.fabric.variantId, quantity: '3' }] });
    expect(out.status).toBe(201);
    const same = await count(w, w.org.auth, { countedAt, lines: [{ variantId: w.fabric.variantId, counted: '10' }] });
    expect(same.body).toMatchObject({ adjustmentId: null, matched: 1 });
    const short = await count(w, w.org.auth, { countedAt, lines: [{ variantId: w.fabric.variantId, counted: '9' }] });
    expect(short.body.differences[0]).toMatchObject({ expected: '10', delta: '-1' });
    const ok = await cmd(ctx.app, w.org.auth, `/v1/inventory/adjustments/${short.body.adjustmentId}/approve`, {});
    expect(ok.status).toBe(403); // the admin who counted cannot approve; a second person does
    const second = await staff(ctx.app, w.org.auth, ['inventory.adjust.approve', 'inventory.read'], { type: 'location', id: w.w1 });
    expect((await cmd(ctx.app, second.auth, `/v1/inventory/adjustments/${short.body.adjustmentId}/approve`, {})).status).toBe(200);
    expect((await balance(ctx.app, w.org.auth, { locationId: w.w1, variantId: w.fabric.variantId })).quantity).toBe('6');   // 10 − 3 sold − 1 missing
  });

  it('counts by lot or roll, and refuses a missing lot, a repeated line and a stale count', async () => {
    const w = await world();
    const rec = await receive(ctx.app, w.org.auth, w.w1, w.rolled.variantId, '60', { lotCode: 'R-1' });
    const lotId = rec.lines[0]!.lotId!;
    const ok = await count(w, w.org.auth, { lines: [{ variantId: w.rolled.variantId, lotId, counted: '58.5' }] });
    expect(ok.body.differences[0]).toMatchObject({ lotCode: 'R-1', delta: '-1.5' });
    expect((await count(w, w.org.auth, { lines: [{ variantId: w.rolled.variantId, counted: '1' }] })).status).toBe(422);
    expect((await count(w, w.org.auth, { lines: [{ variantId: w.fabric.variantId, counted: '1' }, { variantId: w.fabric.variantId, counted: '2' }] })).status).toBe(422);
    expect((await count(w, w.org.auth, { lines: [{ variantId: w.fabric.variantId, counted: '1.234' }] })).status).toBe(422);
    const old = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
    expect((await count(w, w.org.auth, { countedAt: old, lines: [{ variantId: w.fabric.variantId, counted: '1' }] })).status).toBe(422);
  });

  it('is safe to retry: the same key records one count', async () => {
    const w = await world();
    await receive(ctx.app, w.org.auth, w.w1, w.fabric.variantId, '5');
    const key = crypto.randomUUID();
    const a = await count(w, w.org.auth, { lines: [{ variantId: w.fabric.variantId, counted: '4' }] }, key);
    const b = await count(w, w.org.auth, { lines: [{ variantId: w.fabric.variantId, counted: '4' }] }, key);
    expect(b.body.id).toBe(a.body.id);
    const n = await ctx.db.query('SELECT count(*)::int AS n FROM stock_counts WHERE location_id = $1', [w.w1]);
    expect(n.rows[0].n).toBe(1);
  });

  it('needs the right to adjust stock at that place', async () => {
    const w = await world();
    const reader = await staff(ctx.app, w.org.auth, ['inventory.read'], { type: 'location', id: w.w1 });
    expect((await count(w, reader.auth, { lines: [{ variantId: w.fabric.variantId, counted: '1' }] })).status).toBe(403);
    const elsewhere = await staff(ctx.app, w.org.auth, ['inventory.adjust'], { type: 'location', id: w.w2 });
    expect((await count(w, elsewhere.auth, { lines: [{ variantId: w.fabric.variantId, counted: '1' }] })).status).toBe(403);
    expect((await call(ctx.app, 'GET', `/v1/inventory/counts?locationId=${w.w1}`, elsewhere.auth)).body).toEqual([]);
  });
});

describe('stock lookup', () => {
  it('finds a product by barcode, SKU or name and shows the shelf', async () => {
    const w = await world();
    const sku = `LK-${crypto.randomUUID().slice(0, 6)}`;
    const code = `600${Date.now().toString().slice(-9)}`;
    const p = await call(ctx.app, 'POST', '/v1/products', w.org.auth, { name: 'Brocade Gold', baseUnitId: w.m, variants: [{ sku, tracking: 'lot', barcodes: [code] }] });
    expect(p.status).toBe(201);
    const variantId = p.body.variantIds[0];
    await receive(ctx.app, w.org.auth, w.w1, variantId, '12', { lotCode: 'L-9' });
    for (const query of [`code=${code}`, `code=${sku.toLowerCase()}`, 'q=brocade']) {
      const r = await call(ctx.app, 'GET', `/v1/inventory/lookup?locationId=${w.w1}&${query}`, w.org.auth);
      expect(r.status).toBe(200);
      expect(r.body[0]).toMatchObject({ variantId, sku, productName: 'Brocade Gold', tracking: 'lot', unit: 'm', barcode: code, balances: [{ lotCode: 'L-9', quantity: '12', available: '12' }] });
    }
    const none = await call(ctx.app, 'GET', `/v1/inventory/lookup?locationId=${w.w1}&code=nothing-here`, w.org.auth);
    expect(none.body).toEqual([]);
    expect((await call(ctx.app, 'GET', `/v1/inventory/lookup?locationId=${w.w1}`, w.org.auth)).status).toBe(422);
  });

  it('is limited to places the person may see', async () => {
    const w = await world();
    const other = await staff(ctx.app, w.org.auth, ['inventory.read'], { type: 'location', id: w.w2 });
    expect((await call(ctx.app, 'GET', `/v1/inventory/lookup?locationId=${w.w1}&code=x`, other.auth)).status).toBe(403);
  });
});

describe('count sheet', () => {
  it('lists every active product with barcodes and the shelf, for use offline', async () => {
    const w = await world();
    await receive(ctx.app, w.org.auth, w.w1, w.fabric.variantId, '7');
    const r = await call(ctx.app, 'GET', `/v1/inventory/count-sheet?locationId=${w.w1}`, w.org.auth);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ locationId: w.w1, truncated: false });
    const fabric = r.body.items.find((i: any) => i.variantId === w.fabric.variantId);
    expect(fabric).toMatchObject({ productName: 'Fabric', unit: 'm', balances: [{ quantity: '7', available: '7' }] });
    // Products with nothing on the shelf are listed too, so they can be received.
    expect(r.body.items.find((i: any) => i.variantId === w.rolled.variantId).balances).toEqual([]);
    const other = await staff(ctx.app, w.org.auth, ['inventory.read'], { type: 'location', id: w.w2 });
    expect((await call(ctx.app, 'GET', `/v1/inventory/count-sheet?locationId=${w.w1}`, other.auth)).status).toBe(403);
  });
});
