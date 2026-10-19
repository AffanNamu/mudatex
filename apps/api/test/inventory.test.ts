import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, newOrg, setupApp, staff } from './helpers.js';
import { balance, buildWorld, cmd, receive, reconciled, type World } from './inventory-helpers.js';

let ctx: Awaited<ReturnType<typeof setupApp>>;
beforeAll(async () => { ctx = await setupApp(); });
afterAll(async () => { await ctx.close(); });

const world = async () => buildWorld(ctx.app, await newOrg(ctx.db));

describe('receipts and units', () => {
  it('posts a receipt to the ledger and the balance, and reconciles', async () => {
    const w = await world();
    const r = await receive(ctx.app, w.org.auth, w.w1, w.fabric.variantId, '12.5');
    expect(r.lines[0]).toMatchObject({ quantity: '12.5', lotId: null });
    expect(await balance(ctx.app, w.org.auth, { locationId: w.w1, variantId: w.fabric.variantId })).toMatchObject({ quantity: '12.5', available: '12.5' });
    const moves = await call(ctx.app, 'GET', `/v1/inventory/movements?variantId=${w.fabric.variantId}`, w.org.auth);
    expect(moves.body).toHaveLength(1);
    expect(moves.body[0]).toMatchObject({ type: 'receipt', quantity: '12.5', state: 'on_hand' });
    expect(await reconciled(ctx.app, w.org.auth)).toEqual({ consistent: true, discrepancies: [] });
  });

  it('converts only through explicit conversions and never rounds', async () => {
    const w = await world();
    // 3 rolls x 50 = 150 m
    await receive(ctx.app, w.org.auth, w.w1, w.fabric.variantId, '3', { unitId: w.roll });
    expect((await balance(ctx.app, w.org.auth, { locationId: w.w1, variantId: w.fabric.variantId })).quantity).toBe('150');
    // 1 yd = 0.9144 m, which needs 4 decimals; base unit allows 2.
    const bad = await cmd(ctx.app, w.org.auth, '/v1/inventory/receipts', { locationId: w.w1, lines: [{ variantId: w.fabric.variantId, quantity: '1', unitId: w.yd }] });
    expect(bad.status).toBe(422);
    // 2500 yd = 2286 m exactly.
    await receive(ctx.app, w.org.auth, w.w1, w.fabric.variantId, '2500', { unitId: w.yd });
    expect((await balance(ctx.app, w.org.auth, { locationId: w.w1, variantId: w.fabric.variantId })).quantity).toBe('2436');
    // No conversion defined for this product from metre-based unit to a yard-based product.
    const none = await cmd(ctx.app, w.org.auth, '/v1/inventory/receipts', { locationId: w.w1, lines: [{ variantId: w.rolled.variantId, quantity: '1', unitId: w.roll, lotCode: 'X' }] });
    expect(none.status).toBe(422);
    // Over-precise and non-positive quantities are rejected.
    for (const quantity of ['1.234', '0', '0.00']) {
      const r = await cmd(ctx.app, w.org.auth, '/v1/inventory/receipts', { locationId: w.w1, lines: [{ variantId: w.fabric.variantId, quantity }] });
      expect(r.status).toBe(422);
    }
  });

  it('holds stock only at warehouse, branch and storage locations', async () => {
    const w = await world();
    const r = await cmd(ctx.app, w.org.auth, '/v1/inventory/receipts', { locationId: w.dept, lines: [{ variantId: w.fabric.variantId, quantity: '1' }] });
    expect(r.status).toBe(422);
  });

  it('requires lots for tracked variants and rejects them for untracked ones', async () => {
    const w = await world();
    const noLot = await cmd(ctx.app, w.org.auth, '/v1/inventory/receipts', { locationId: w.w1, lines: [{ variantId: w.rolled.variantId, quantity: '10' }] });
    expect(noLot.status).toBe(422);
    const extra = await cmd(ctx.app, w.org.auth, '/v1/inventory/receipts', { locationId: w.w1, lines: [{ variantId: w.fabric.variantId, quantity: '10', lotCode: 'L1' }] });
    expect(extra.status).toBe(422);
    // A lot-tracked variant accumulates into the same lot; a roll code can only be received once.
    const a = await receive(ctx.app, w.org.auth, w.w1, w.lotted.variantId, '5', { lotCode: 'BATCH-1' });
    const b = await receive(ctx.app, w.org.auth, w.w1, w.lotted.variantId, '7', { lotCode: 'BATCH-1' });
    expect(b.lines[0]!.lotId).toBe(a.lines[0]!.lotId);
    expect((await balance(ctx.app, w.org.auth, { locationId: w.w1, variantId: w.lotted.variantId, lotId: a.lines[0]!.lotId! })).quantity).toBe('12');
    await receive(ctx.app, w.org.auth, w.w1, w.rolled.variantId, '100', { lotCode: 'R-1' });
    const dup = await cmd(ctx.app, w.org.auth, '/v1/inventory/receipts', { locationId: w.w1, lines: [{ variantId: w.rolled.variantId, quantity: '100', lotCode: 'R-1' }] });
    expect(dup.status).toBe(409);
  });

  it('cannot change a variant tracking mode once stock history exists', async () => {
    const w = await world();
    await receive(ctx.app, w.org.auth, w.w1, w.fabric.variantId, '1');
    await expect(ctx.db.query("UPDATE product_variants SET tracking = 'lot' WHERE id = $1", [w.fabric.variantId])).rejects.toThrow(/tracking cannot change/);
  });
});

describe('idempotency', () => {
  it('requires a key and replays the stored response for an identical retry', async () => {
    const w = await world();
    const body = { locationId: w.w1, lines: [{ variantId: w.fabric.variantId, quantity: '10' }] };
    expect((await call(ctx.app, 'POST', '/v1/inventory/receipts', w.org.auth, body)).status).toBe(400);

    const key = 'retry-key-0001';
    const first = await cmd(ctx.app, w.org.auth, '/v1/inventory/receipts', body, key);
    const res = await ctx.app.inject({ method: 'POST', url: '/v1/inventory/receipts', headers: { ...w.org.auth, 'idempotency-key': key }, payload: body });
    expect(res.statusCode).toBe(201);
    expect(res.headers['idempotent-replayed']).toBe('true');
    expect(JSON.parse(res.body)).toEqual(first.body);
    expect((await balance(ctx.app, w.org.auth, { locationId: w.w1, variantId: w.fabric.variantId })).quantity).toBe('10');
  });

  it('rejects reuse of a key for a different request', async () => {
    const w = await world();
    const key = 'reuse-key-0001';
    await cmd(ctx.app, w.org.auth, '/v1/inventory/receipts', { locationId: w.w1, lines: [{ variantId: w.fabric.variantId, quantity: '10' }] }, key);
    const other = await cmd(ctx.app, w.org.auth, '/v1/inventory/receipts', { locationId: w.w1, lines: [{ variantId: w.fabric.variantId, quantity: '11' }] }, key);
    expect(other.status).toBe(422);
  });

  it('applies a command once when the same request is replayed 10 times concurrently', async () => {
    const w = await world();
    const body = { locationId: w.w1, lines: [{ variantId: w.fabric.variantId, quantity: '10' }] };
    const key = 'concurrent-key-1';
    const results = await Promise.all(Array.from({ length: 10 }, () => cmd(ctx.app, w.org.auth, '/v1/inventory/receipts', body, key)));
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(new Set(results.map((r) => r.body.commandId)).size).toBe(1);
    expect((await balance(ctx.app, w.org.auth, { locationId: w.w1, variantId: w.fabric.variantId })).quantity).toBe('10');
    const moves = await call(ctx.app, 'GET', `/v1/inventory/movements?variantId=${w.fabric.variantId}`, w.org.auth);
    expect(moves.body).toHaveLength(1);
  });

  it('does not store failed commands, so a corrected retry runs again', async () => {
    const w = await world();
    const key = 'failed-key-0001';
    const fail = await cmd(ctx.app, w.org.auth, '/v1/inventory/issues', { locationId: w.w1, reasonCode: 'sale', lines: [{ variantId: w.fabric.variantId, quantity: '5' }] }, key);
    expect(fail.status).toBe(409);
    await receive(ctx.app, w.org.auth, w.w1, w.fabric.variantId, '5');
    const retry = await cmd(ctx.app, w.org.auth, '/v1/inventory/issues', { locationId: w.w1, reasonCode: 'sale', lines: [{ variantId: w.fabric.variantId, quantity: '5' }] }, key);
    expect(retry.status).toBe(201);
  });
});

describe('overselling', () => {
  it('lets exactly the available quantity be reserved under concurrent load', async () => {
    const w = await world();
    await receive(ctx.app, w.org.auth, w.w1, w.fabric.variantId, '10');
    const attempts = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        cmd(ctx.app, w.org.auth, '/v1/inventory/reservations', { locationId: w.w1, variantId: w.fabric.variantId, quantity: '1', referenceType: 'order', referenceId: `O-${i}` }),
      ),
    );
    expect(attempts.filter((r) => r.status === 201)).toHaveLength(10);
    expect(attempts.filter((r) => r.status === 409)).toHaveLength(20);
    expect(await balance(ctx.app, w.org.auth, { locationId: w.w1, variantId: w.fabric.variantId })).toMatchObject({ quantity: '10', reserved: '10', available: '0' });
    expect((await reconciled(ctx.app, w.org.auth)).consistent).toBe(true);
  });

  it('never lets mixed concurrent issues and reservations exceed on-hand stock', async () => {
    const w = await world();
    await receive(ctx.app, w.org.auth, w.w1, w.fabric.variantId, '10');
    const ops = Array.from({ length: 24 }, (_, i) =>
      i % 2
        ? cmd(ctx.app, w.org.auth, '/v1/inventory/issues', { locationId: w.w1, reasonCode: 'sale', lines: [{ variantId: w.fabric.variantId, quantity: '1' }] })
        : cmd(ctx.app, w.org.auth, '/v1/inventory/reservations', { locationId: w.w1, variantId: w.fabric.variantId, quantity: '1', referenceType: 'order', referenceId: `M-${i}` }),
    );
    const results = await Promise.all(ops);
    expect(results.filter((r) => r.status === 201)).toHaveLength(10);
    const b = await balance(ctx.app, w.org.auth, { locationId: w.w1, variantId: w.fabric.variantId });
    expect(Number(b.quantity) - Number(b.reserved)).toBe(0);
    expect(Number(b.quantity)).toBeGreaterThanOrEqual(0);
    expect((await reconciled(ctx.app, w.org.auth)).consistent).toBe(true);
  });

  it('keeps the database constraints as a backstop against direct writes', async () => {
    const w = await world();
    await receive(ctx.app, w.org.auth, w.w1, w.fabric.variantId, '5');
    await expect(ctx.db.query("UPDATE stock_balances SET quantity = -1 WHERE variant_id = $1", [w.fabric.variantId])).rejects.toThrow(/stock_balances_quantity_check/);
    await expect(ctx.db.query("UPDATE stock_balances SET reserved = 6 WHERE variant_id = $1", [w.fabric.variantId])).rejects.toThrow(/stock_balances_reserved_check/);
  });

  it('never allows a negative balance through issues', async () => {
    const w = await world();
    await receive(ctx.app, w.org.auth, w.w1, w.fabric.variantId, '5');
    const r = await cmd(ctx.app, w.org.auth, '/v1/inventory/issues', { locationId: w.w1, reasonCode: 'sale', lines: [{ variantId: w.fabric.variantId, quantity: '5.01' }] });
    expect(r.status).toBe(409);
    expect((await balance(ctx.app, w.org.auth, { locationId: w.w1, variantId: w.fabric.variantId })).quantity).toBe('5');
  });

  it('applies a multi-line command atomically', async () => {
    const w = await world();
    await receive(ctx.app, w.org.auth, w.w1, w.fabric.variantId, '5');
    const r = await cmd(ctx.app, w.org.auth, '/v1/inventory/issues', {
      locationId: w.w1,
      reasonCode: 'sale',
      lines: [{ variantId: w.fabric.variantId, quantity: '3' }, { variantId: w.fabric.variantId, quantity: '3' }],
    });
    expect(r.status).toBe(409);
    expect((await balance(ctx.app, w.org.auth, { locationId: w.w1, variantId: w.fabric.variantId })).quantity).toBe('5');
    expect((await call(ctx.app, 'GET', `/v1/inventory/movements?variantId=${w.fabric.variantId}`, w.org.auth)).body).toHaveLength(1);
  });
});

describe('reservations', () => {
  it('fulfils in parts, closes, and rejects further fulfilment', async () => {
    const w = await world();
    await receive(ctx.app, w.org.auth, w.w1, w.fabric.variantId, '10');
    const res = await cmd(ctx.app, w.org.auth, '/v1/inventory/reservations', { locationId: w.w1, variantId: w.fabric.variantId, quantity: '6', referenceType: 'order', referenceId: 'O-1' });
    const id = res.body.id;

    const part = await cmd(ctx.app, w.org.auth, `/v1/inventory/reservations/${id}/fulfil`, { quantity: '2.5' });
    expect(part.body).toMatchObject({ fulfilled: '2.5', remaining: '3.5', status: 'active' });
    expect(await balance(ctx.app, w.org.auth, { locationId: w.w1, variantId: w.fabric.variantId })).toMatchObject({ quantity: '7.5', reserved: '3.5', available: '4' });

    expect((await cmd(ctx.app, w.org.auth, `/v1/inventory/reservations/${id}/fulfil`, { quantity: '3.51' })).status).toBe(409);
    const rest = await cmd(ctx.app, w.org.auth, `/v1/inventory/reservations/${id}/fulfil`, {});
    expect(rest.body).toMatchObject({ fulfilled: '3.5', remaining: '0', status: 'closed' });
    expect(await balance(ctx.app, w.org.auth, { locationId: w.w1, variantId: w.fabric.variantId })).toMatchObject({ quantity: '4', reserved: '0' });
    expect((await cmd(ctx.app, w.org.auth, `/v1/inventory/reservations/${id}/fulfil`, {})).status).toBe(409);
    expect((await call(ctx.app, 'GET', `/v1/inventory/reservations/${id}`, w.org.auth)).body).toMatchObject({ status: 'closed', fulfilledQuantity: '6' });
    expect((await reconciled(ctx.app, w.org.auth)).consistent).toBe(true);
  });

  it('releases the unfulfilled remainder', async () => {
    const w = await world();
    await receive(ctx.app, w.org.auth, w.w1, w.fabric.variantId, '10');
    const res = await cmd(ctx.app, w.org.auth, '/v1/inventory/reservations', { locationId: w.w1, variantId: w.fabric.variantId, quantity: '6', referenceType: 'order', referenceId: 'O-2' });
    await cmd(ctx.app, w.org.auth, `/v1/inventory/reservations/${res.body.id}/fulfil`, { quantity: '1' });
    const rel = await cmd(ctx.app, w.org.auth, `/v1/inventory/reservations/${res.body.id}/release`, {});
    expect(rel.body).toMatchObject({ released: '5', status: 'closed' });
    expect(await balance(ctx.app, w.org.auth, { locationId: w.w1, variantId: w.fabric.variantId })).toMatchObject({ quantity: '9', reserved: '0', available: '9' });
    expect((await cmd(ctx.app, w.org.auth, `/v1/inventory/reservations/${res.body.id}/release`, {})).status).toBe(409);
  });

  it('releases expired reservations and refuses to fulfil them', async () => {
    const { releaseExpiredReservations } = await import('../src/inventory/expiry.js');
    const w = await world();
    await receive(ctx.app, w.org.auth, w.w1, w.fabric.variantId, '10');
    const past = new Date(Date.now() - 60_000).toISOString();
    const res = await cmd(ctx.app, w.org.auth, '/v1/inventory/reservations', { locationId: w.w1, variantId: w.fabric.variantId, quantity: '4', referenceType: 'cart', referenceId: 'C-1', expiresAt: past });
    expect(res.status).toBe(201);
    expect((await cmd(ctx.app, w.org.auth, `/v1/inventory/reservations/${res.body.id}/fulfil`, {})).status).toBe(409);
    expect((await balance(ctx.app, w.org.auth, { locationId: w.w1, variantId: w.fabric.variantId })).available).toBe('6');
    expect(await releaseExpiredReservations(ctx.db)).toBeGreaterThanOrEqual(1);
    expect((await balance(ctx.app, w.org.auth, { locationId: w.w1, variantId: w.fabric.variantId })).available).toBe('10');
    expect((await call(ctx.app, 'GET', `/v1/inventory/reservations/${res.body.id}`, w.org.auth)).body.status).toBe('closed');
  });

  it('reserves a specific roll for tracked variants', async () => {
    const w = await world();
    const r = await receive(ctx.app, w.org.auth, w.w1, w.rolled.variantId, '40', { lotCode: 'RR-1' });
    const lotId = r.lines[0]!.lotId!;
    const noLot = await cmd(ctx.app, w.org.auth, '/v1/inventory/reservations', { locationId: w.w1, variantId: w.rolled.variantId, quantity: '10', referenceType: 'order', referenceId: 'O' });
    expect(noLot.status).toBe(422);
    const ok = await cmd(ctx.app, w.org.auth, '/v1/inventory/reservations', { locationId: w.w1, variantId: w.rolled.variantId, lotId, quantity: '10', referenceType: 'order', referenceId: 'O' });
    expect(ok.status).toBe(201);
    expect(await balance(ctx.app, w.org.auth, { locationId: w.w1, variantId: w.rolled.variantId, lotId })).toMatchObject({ reserved: '10', available: '30' });
  });
});

describe('roll splitting', () => {
  it('conserves quantity and records lineage', async () => {
    const w = await world();
    const r = await receive(ctx.app, w.org.auth, w.w1, w.rolled.variantId, '100', { lotCode: 'ROLL-100' });
    const parent = r.lines[0]!.lotId!;
    const split = await cmd(ctx.app, w.org.auth, `/v1/inventory/rolls/${parent}/split`, {
      locationId: w.w1,
      children: [{ code: 'ROLL-100-A', quantity: '7.5' }, { code: 'ROLL-100-B', quantity: '12' }],
    });
    expect(split.status).toBe(201);
    expect(split.body.total).toBe('19.5');
    const [a, b] = split.body.children;
    expect((await balance(ctx.app, w.org.auth, { locationId: w.w1, variantId: w.rolled.variantId, lotId: parent })).quantity).toBe('80.5');
    expect((await balance(ctx.app, w.org.auth, { locationId: w.w1, variantId: w.rolled.variantId, lotId: a.lotId })).quantity).toBe('7.5');
    expect((await balance(ctx.app, w.org.auth, { locationId: w.w1, variantId: w.rolled.variantId, lotId: b.lotId })).quantity).toBe('12');

    const moves = await call(ctx.app, 'GET', `/v1/inventory/movements?referenceType=roll_split&referenceId=${parent}`, w.org.auth);
    const net = moves.body.reduce((acc: number, m: any) => acc + Number(m.quantity), 0);
    expect(net).toBe(0);
    const lots = await call(ctx.app, 'GET', `/v1/inventory/lots?variantId=${w.rolled.variantId}`, w.org.auth);
    expect(lots.body.filter((l: any) => l.parentLotId === parent).map((l: any) => l.code).sort()).toEqual(['ROLL-100-A', 'ROLL-100-B']);
    expect((await reconciled(ctx.app, w.org.auth)).consistent).toBe(true);
  });

  it('refuses to split more than is free, including stock that is reserved', async () => {
    const w = await world();
    const r = await receive(ctx.app, w.org.auth, w.w1, w.rolled.variantId, '20', { lotCode: 'ROLL-20' });
    const lotId = r.lines[0]!.lotId!;
    await cmd(ctx.app, w.org.auth, '/v1/inventory/reservations', { locationId: w.w1, variantId: w.rolled.variantId, lotId, quantity: '15', referenceType: 'order', referenceId: 'O' });
    const over = await cmd(ctx.app, w.org.auth, `/v1/inventory/rolls/${lotId}/split`, { locationId: w.w1, children: [{ code: 'C1', quantity: '6' }] });
    expect(over.status).toBe(409);
    // The failed split leaves no child roll behind.
    const lots = await call(ctx.app, 'GET', `/v1/inventory/lots?variantId=${w.rolled.variantId}`, w.org.auth);
    expect(lots.body).toHaveLength(1);
    expect((await cmd(ctx.app, w.org.auth, `/v1/inventory/rolls/${lotId}/split`, { locationId: w.w1, children: [{ code: 'C1', quantity: '5' }] })).status).toBe(201);
  });

  it('rejects duplicate child codes and non-roll lots', async () => {
    const w = await world();
    const r = await receive(ctx.app, w.org.auth, w.w1, w.rolled.variantId, '20', { lotCode: 'ROLL-D' });
    const lotId = r.lines[0]!.lotId!;
    expect((await cmd(ctx.app, w.org.auth, `/v1/inventory/rolls/${lotId}/split`, { locationId: w.w1, children: [{ code: 'X', quantity: '1' }, { code: 'X', quantity: '1' }] })).status).toBe(422);
    expect((await cmd(ctx.app, w.org.auth, `/v1/inventory/rolls/${lotId}/split`, { locationId: w.w1, children: [{ code: 'ROLL-D', quantity: '1' }] })).status).toBe(409);
    const batch = await receive(ctx.app, w.org.auth, w.w1, w.lotted.variantId, '5', { lotCode: 'B' });
    expect((await cmd(ctx.app, w.org.auth, `/v1/inventory/rolls/${batch.lines[0]!.lotId}/split`, { locationId: w.w1, children: [{ code: 'Y', quantity: '1' }] })).status).toBe(422);
  });
});

describe('transfers', () => {
  it('moves stock through in-transit and reconciles at every step', async () => {
    const w = await world();
    await receive(ctx.app, w.org.auth, w.w1, w.fabric.variantId, '100');
    const t = await cmd(ctx.app, w.org.auth, '/v1/inventory/transfers', { sourceLocationId: w.w1, destinationLocationId: w.w2, lines: [{ variantId: w.fabric.variantId, quantity: '10' }] });
    expect(t.status).toBe(201);
    const id = t.body.id;
    const line = t.body.lines[0].id;

    const q = { variantId: w.fabric.variantId };
    expect((await balance(ctx.app, w.org.auth, { locationId: w.w1, ...q })).quantity).toBe('90');
    expect((await balance(ctx.app, w.org.auth, { locationId: w.w2, ...q, state: 'in_transit' })).quantity).toBe('10');
    expect((await balance(ctx.app, w.org.auth, { locationId: w.w2, ...q })).quantity).toBe('0');
    expect((await reconciled(ctx.app, w.org.auth)).consistent).toBe(true);

    const part = await cmd(ctx.app, w.org.auth, `/v1/inventory/transfers/${id}/receive`, { lines: [{ lineId: line, quantity: '4' }] });
    expect(part.body.status).toBe('in_transit');
    expect((await balance(ctx.app, w.org.auth, { locationId: w.w2, ...q })).quantity).toBe('4');
    expect((await balance(ctx.app, w.org.auth, { locationId: w.w2, ...q, state: 'in_transit' })).quantity).toBe('6');
    expect((await cmd(ctx.app, w.org.auth, `/v1/inventory/transfers/${id}/receive`, { lines: [{ lineId: line, quantity: '6.01' }] })).status).toBe(409);

    const cancel = await cmd(ctx.app, w.org.auth, `/v1/inventory/transfers/${id}/cancel`, {});
    expect(cancel.body.status).toBe('completed');
    expect((await balance(ctx.app, w.org.auth, { locationId: w.w1, ...q })).quantity).toBe('96');
    expect((await balance(ctx.app, w.org.auth, { locationId: w.w2, ...q, state: 'in_transit' })).quantity).toBe('0');
    expect((await cmd(ctx.app, w.org.auth, `/v1/inventory/transfers/${id}/receive`, { lines: [{ lineId: line, quantity: '1' }] })).status).toBe(409);

    const moves = await call(ctx.app, 'GET', `/v1/inventory/movements?referenceType=transfer&referenceId=${id}`, w.org.auth);
    expect(moves.body.reduce((acc: number, m: any) => acc + Number(m.quantity), 0)).toBe(0);
    expect((await reconciled(ctx.app, w.org.auth)).consistent).toBe(true);
  });

  it('carries a roll through a transfer and completes on full receipt', async () => {
    const w = await world();
    const r = await receive(ctx.app, w.org.auth, w.w1, w.rolled.variantId, '60', { lotCode: 'T-ROLL' });
    const lotId = r.lines[0]!.lotId!;
    const t = await cmd(ctx.app, w.org.auth, '/v1/inventory/transfers', { sourceLocationId: w.w1, destinationLocationId: w.shop, lines: [{ variantId: w.rolled.variantId, lotId, quantity: '60' }] });
    const done = await cmd(ctx.app, w.org.auth, `/v1/inventory/transfers/${t.body.id}/receive`, { lines: [{ lineId: t.body.lines[0].id, quantity: '60' }] });
    expect(done.body.status).toBe('completed');
    expect((await balance(ctx.app, w.org.auth, { locationId: w.shop, variantId: w.rolled.variantId, lotId })).quantity).toBe('60');
    expect((await balance(ctx.app, w.org.auth, { locationId: w.w1, variantId: w.rolled.variantId, lotId })).quantity).toBe('0');
  });

  it('cannot dispatch reserved stock, cross-entity, or to the same location', async () => {
    const w = await world();
    await receive(ctx.app, w.org.auth, w.w1, w.fabric.variantId, '10');
    await cmd(ctx.app, w.org.auth, '/v1/inventory/reservations', { locationId: w.w1, variantId: w.fabric.variantId, quantity: '8', referenceType: 'order', referenceId: 'O' });
    const line = { variantId: w.fabric.variantId, quantity: '3' };
    expect((await cmd(ctx.app, w.org.auth, '/v1/inventory/transfers', { sourceLocationId: w.w1, destinationLocationId: w.w2, lines: [line] })).status).toBe(409);
    expect((await cmd(ctx.app, w.org.auth, '/v1/inventory/transfers', { sourceLocationId: w.w1, destinationLocationId: w.g1, lines: [{ ...line, quantity: '1' }] })).status).toBe(422);
    expect((await cmd(ctx.app, w.org.auth, '/v1/inventory/transfers', { sourceLocationId: w.w1, destinationLocationId: w.w1, lines: [{ ...line, quantity: '1' }] })).status).toBe(422);
  });

  it('requires receive rights at the destination, not just the source', async () => {
    const w = await world();
    await receive(ctx.app, w.org.auth, w.w1, w.fabric.variantId, '10');
    const t = await cmd(ctx.app, w.org.auth, '/v1/inventory/transfers', { sourceLocationId: w.w1, destinationLocationId: w.w2, lines: [{ variantId: w.fabric.variantId, quantity: '5' }] });
    const sourceOnly = await staff(ctx.app, w.org.auth, ['inventory.receive', 'inventory.transfer'], { type: 'location', id: w.w1 });
    const r = await cmd(ctx.app, sourceOnly.auth, `/v1/inventory/transfers/${t.body.id}/receive`, { lines: [{ lineId: t.body.lines[0].id, quantity: '5' }] });
    expect(r.status).toBe(403);
    const dest = await staff(ctx.app, w.org.auth, ['inventory.receive'], { type: 'location', id: w.w2 });
    expect((await cmd(ctx.app, dest.auth, `/v1/inventory/transfers/${t.body.id}/receive`, { lines: [{ lineId: t.body.lines[0].id, quantity: '5' }] })).status).toBe(200);
  });
});

describe('adjustments (maker-checker)', () => {
  it('changes nothing until a different user approves', async () => {
    const w = await world();
    await receive(ctx.app, w.org.auth, w.w1, w.fabric.variantId, '10');
    const maker = await staff(ctx.app, w.org.auth, ['inventory.adjust', 'inventory.read'], { type: 'location', id: w.w1 });
    const adj = await cmd(ctx.app, maker.auth, '/v1/inventory/adjustments', { locationId: w.w1, reason: 'Cycle count shortage', lines: [{ variantId: w.fabric.variantId, direction: 'decrease', quantity: '2.5' }] });
    expect(adj.status).toBe(201);
    expect(adj.body.status).toBe('pending');
    expect((await balance(ctx.app, w.org.auth, { locationId: w.w1, variantId: w.fabric.variantId })).quantity).toBe('10');

    const both = await staff(ctx.app, w.org.auth, ['inventory.adjust', 'inventory.adjust.approve'], { type: 'location', id: w.w1 });
    const own = await cmd(ctx.app, both.auth, '/v1/inventory/adjustments', { locationId: w.w1, reason: 'Found extra stock', lines: [{ variantId: w.fabric.variantId, direction: 'increase', quantity: '1' }] });
    expect((await cmd(ctx.app, both.auth, `/v1/inventory/adjustments/${own.body.id}/approve`, {})).status).toBe(403);
    expect((await cmd(ctx.app, maker.auth, `/v1/inventory/adjustments/${adj.body.id}/approve`, {})).status).toBe(403);

    const ok = await cmd(ctx.app, w.org.auth, `/v1/inventory/adjustments/${adj.body.id}/approve`, { note: 'verified' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'approved', decidedBy: w.org.userId });
    expect((await balance(ctx.app, w.org.auth, { locationId: w.w1, variantId: w.fabric.variantId })).quantity).toBe('7.5');
    const moves = await call(ctx.app, 'GET', `/v1/inventory/movements?referenceType=adjustment&referenceId=${adj.body.id}`, w.org.auth);
    expect(moves.body[0]).toMatchObject({ type: 'adjustment', quantity: '-2.5', reason: 'Cycle count shortage' });
    expect((await cmd(ctx.app, w.org.auth, `/v1/inventory/adjustments/${adj.body.id}/approve`, {})).status).toBe(409);
    expect((await reconciled(ctx.app, w.org.auth)).consistent).toBe(true);
  });

  it('can be rejected with a note, and needs a real reason', async () => {
    const w = await world();
    await receive(ctx.app, w.org.auth, w.w1, w.fabric.variantId, '10');
    const maker = await staff(ctx.app, w.org.auth, ['inventory.adjust'], { type: 'location', id: w.w1 });
    expect((await cmd(ctx.app, maker.auth, '/v1/inventory/adjustments', { locationId: w.w1, reason: 'oops', lines: [{ variantId: w.fabric.variantId, direction: 'decrease', quantity: '1' }] })).status).toBe(400);
    const adj = await cmd(ctx.app, maker.auth, '/v1/inventory/adjustments', { locationId: w.w1, reason: 'Suspected damage', lines: [{ variantId: w.fabric.variantId, direction: 'decrease', quantity: '1' }] });
    const rej = await cmd(ctx.app, w.org.auth, `/v1/inventory/adjustments/${adj.body.id}/reject`, { note: 'Recount first' });
    expect(rej.body).toMatchObject({ status: 'rejected', decisionNote: 'Recount first' });
    expect((await balance(ctx.app, w.org.auth, { locationId: w.w1, variantId: w.fabric.variantId })).quantity).toBe('10');
  });

  it('stays pending when approval would drive stock negative', async () => {
    const w = await world();
    await receive(ctx.app, w.org.auth, w.w1, w.fabric.variantId, '1');
    const maker = await staff(ctx.app, w.org.auth, ['inventory.adjust'], { type: 'location', id: w.w1 });
    const adj = await cmd(ctx.app, maker.auth, '/v1/inventory/adjustments', { locationId: w.w1, reason: 'Write off damaged', lines: [{ variantId: w.fabric.variantId, direction: 'decrease', quantity: '5' }] });
    expect((await cmd(ctx.app, w.org.auth, `/v1/inventory/adjustments/${adj.body.id}/approve`, {})).status).toBe(409);
    expect((await call(ctx.app, 'GET', `/v1/inventory/adjustments/${adj.body.id}`, w.org.auth)).body.status).toBe('pending');
  });
});

describe('ledger integrity and access', () => {
  it('rejects edits to posted movements', async () => {
    const w = await world();
    await receive(ctx.app, w.org.auth, w.w1, w.fabric.variantId, '1');
    await expect(ctx.db.query('UPDATE stock_movements SET quantity = 99')).rejects.toThrow(/append-only/);
    await expect(ctx.db.query('DELETE FROM stock_movements')).rejects.toThrow(/append-only/);
    await expect(ctx.db.query('TRUNCATE stock_movements')).rejects.toThrow(/append-only/);
  });

  it('detects a balance edited without a movement', async () => {
    const w = await world();
    await receive(ctx.app, w.org.auth, w.w1, w.fabric.variantId, '5');
    await ctx.db.query('UPDATE stock_balances SET quantity = 6 WHERE variant_id = $1', [w.fabric.variantId]);
    const r = await reconciled(ctx.app, w.org.auth);
    expect(r.consistent).toBe(false);
    expect(r.discrepancies).toHaveLength(1);
    await ctx.db.query('UPDATE stock_balances SET quantity = 5 WHERE variant_id = $1', [w.fabric.variantId]);
  });

  it('enforces location scope on writes and filters reads', async () => {
    const w = await world();
    await receive(ctx.app, w.org.auth, w.w1, w.fabric.variantId, '5');
    await receive(ctx.app, w.org.auth, w.w2, w.fabric.variantId, '7');
    const w1Clerk = await staff(ctx.app, w.org.auth, ['inventory.receive', 'inventory.read'], { type: 'location', id: w.w1 });
    expect((await cmd(ctx.app, w1Clerk.auth, '/v1/inventory/receipts', { locationId: w.w1, lines: [{ variantId: w.fabric.variantId, quantity: '1' }] })).status).toBe(201);
    expect((await cmd(ctx.app, w1Clerk.auth, '/v1/inventory/receipts', { locationId: w.w2, lines: [{ variantId: w.fabric.variantId, quantity: '1' }] })).status).toBe(403);
    const visible = await call(ctx.app, 'GET', '/v1/inventory/balances', w1Clerk.auth);
    expect(visible.body.map((b: any) => b.locationId)).toEqual([w.w1]);
    expect((await call(ctx.app, 'GET', `/v1/inventory/movements?locationId=${w.w2}`, w1Clerk.auth)).body).toEqual([]);
    // Reconciliation is organization-wide, so a location grant is not enough.
    expect((await call(ctx.app, 'GET', '/v1/inventory/reconciliation', w1Clerk.auth)).status).toBe(403);
    const noRead = await staff(ctx.app, w.org.auth, ['inventory.receive'], { type: 'location', id: w.w1 });
    expect((await call(ctx.app, 'GET', '/v1/inventory/balances', noRead.auth)).body).toEqual([]);
  });

  it('keeps organizations apart', async () => {
    const a = await world();
    const b = await world();
    await receive(ctx.app, a.org.auth, a.w1, a.fabric.variantId, '5');
    expect((await call(ctx.app, 'GET', '/v1/inventory/balances', b.org.auth)).body).toEqual([]);
    const cross = await cmd(ctx.app, b.org.auth, '/v1/inventory/receipts', { locationId: a.w1, lines: [{ variantId: a.fabric.variantId, quantity: '1' }] });
    expect(cross.status).toBe(404);
    const crossVariant = await cmd(ctx.app, b.org.auth, '/v1/inventory/receipts', { locationId: b.w1, lines: [{ variantId: a.fabric.variantId, quantity: '1' }] });
    expect(crossVariant.status).toBe(404);
  });

  it('writes an audit entry for each command', async () => {
    const w = await world();
    const r = await receive(ctx.app, w.org.auth, w.w1, w.fabric.variantId, '5');
    const log = await call(ctx.app, 'GET', `/v1/audit-log?entityType=stock_command&entityId=${r.commandId}`, w.org.auth);
    expect(log.body[0]).toMatchObject({ action: 'inventory.receipt', actorUserId: w.org.userId });
  });
});
