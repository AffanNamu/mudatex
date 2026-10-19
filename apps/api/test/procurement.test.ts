import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, newOrg, setupApp, staff, type Headers } from './helpers.js';
import { balance, buildWorld, cmd, reconciled, type World } from './inventory-helpers.js';

let ctx: Awaited<ReturnType<typeof setupApp>>;
beforeAll(async () => { ctx = await setupApp(); });
afterAll(async () => { await ctx.close(); });

interface Buying extends World {
  supplier: string;
  buyer: Awaited<ReturnType<typeof staff>>;
  approver: Awaited<ReturnType<typeof staff>>;
  store: Awaited<ReturnType<typeof staff>>;
}

async function buying(): Promise<Buying> {
  const w = await buildWorld(ctx.app, await newOrg(ctx.db));
  const s = await call(ctx.app, 'POST', '/v1/procurement/suppliers', w.org.auth, { code: 'TEX-1', name: 'Textile Mills Ltd', countryCode: 'CN', defaultCurrency: 'USD', paymentTermsDays: 30 });
  expect(s.status).toBe(201);
  const at = { type: 'location', id: w.w1 };
  return {
    ...w,
    supplier: s.body.id,
    buyer: await staff(ctx.app, w.org.auth, ['procurement.create', 'procurement.read'], at),
    approver: await staff(ctx.app, w.org.auth, ['procurement.approve', 'procurement.read'], at),
    store: await staff(ctx.app, w.org.auth, ['procurement.receive', 'procurement.return', 'procurement.read', 'inventory.read'], at),
  };
}

const poBody = (b: Buying, lines: unknown[], extra: Record<string, unknown> = {}) => ({ supplierId: b.supplier, destinationLocationId: b.w1, lines, ...extra });
const fabricLine = (b: Buying, quantity = '100', unitPrice = '12.5', extra: Record<string, unknown> = {}) => ({ variantId: b.fabric.variantId, quantity, unitPrice, ...extra });
const poPath = (id: string, tail = '') => `/v1/procurement/purchase-orders/${id}${tail}`;

async function approvedPo(b: Buying, lines: unknown[] = [fabricLine(b)], extra: Record<string, unknown> = {}) {
  const po = await cmd(ctx.app, b.buyer.auth, '/v1/procurement/purchase-orders', poBody(b, lines, extra));
  expect(po.status).toBe(201);
  expect((await cmd(ctx.app, b.buyer.auth, poPath(po.body.id, '/submit'), {})).status).toBe(200);
  const ok = await cmd(ctx.app, b.approver.auth, poPath(po.body.id, '/approve'), {});
  expect(ok.status).toBe(200);
  return ok.body;
}

const receive = (b: Buying, poId: string, lines: unknown[], auth: Headers = b.store.auth, key?: string) =>
  cmd(ctx.app, auth, poPath(poId, '/receipts'), { lines }, key);
const fabricStock = (b: Buying) => balance(ctx.app, b.org.auth, { locationId: b.w1, variantId: b.fabric.variantId });

describe('suppliers', () => {
  it('are shared master data that need a group-level grant to change', async () => {
    const b = await buying();
    expect((await call(ctx.app, 'POST', '/v1/procurement/suppliers', b.org.auth, { code: 'TEX-1', name: 'Dup', countryCode: 'CN', defaultCurrency: 'USD' })).status).toBe(409);
    expect((await call(ctx.app, 'POST', '/v1/procurement/suppliers', b.buyer.auth, { code: 'NEW', name: 'N', countryCode: 'CN', defaultCurrency: 'USD' })).status).toBe(403);
    expect((await call(ctx.app, 'POST', '/v1/procurement/suppliers', b.org.auth, { code: 'BAD', name: 'N', countryCode: 'CN', defaultCurrency: 'QQQ' })).status).toBe(422);
    expect((await call(ctx.app, 'GET', '/v1/procurement/suppliers', b.buyer.auth)).body).toHaveLength(1);
  });

  it('cannot be ordered from while blocked', async () => {
    const b = await buying();
    const po = await cmd(ctx.app, b.buyer.auth, '/v1/procurement/purchase-orders', poBody(b, [fabricLine(b)]));
    await call(ctx.app, 'POST', `/v1/procurement/suppliers/${b.supplier}/block`, b.org.auth);
    expect((await cmd(ctx.app, b.buyer.auth, '/v1/procurement/purchase-orders', poBody(b, [fabricLine(b)]))).status).toBe(409);
    expect((await cmd(ctx.app, b.buyer.auth, poPath(po.body.id, '/submit'), {})).status).toBe(409);
    await call(ctx.app, 'POST', `/v1/procurement/suppliers/${b.supplier}/unblock`, b.org.auth);
    expect((await cmd(ctx.app, b.buyer.auth, poPath(po.body.id, '/submit'), {})).status).toBe(200);
  });
});

describe('purchase order lifecycle', () => {
  it('prices lines exactly, converts units and numbers orders per legal entity', async () => {
    const b = await buying();
    const po = await cmd(ctx.app, b.buyer.auth, '/v1/procurement/purchase-orders', poBody(b, [
      fabricLine(b, '2', '12.5', { unitId: b.roll }),              // 2 rolls = 100 m x 12.50 = 1,250.00
      { variantId: b.rolled.variantId, quantity: '300', unitPrice: '7.25' }, // 300 yd x 7.25 = 2,175.00
    ]));
    expect(po.status).toBe(201);
    expect(po.body).toMatchObject({ poNumber: 'PO-000001', status: 'draft', currency: 'USD', totalMinor: 342500 });
    expect(po.body.lines[0]).toMatchObject({ quantity: '100', unitPrice: '12.5', totalMinor: 125000, outstandingQuantity: '100' });
    const second = await cmd(ctx.app, b.buyer.auth, '/v1/procurement/purchase-orders', poBody(b, [fabricLine(b)]));
    expect(second.body.poNumber).toBe('PO-000002');
  });

  it('requires a different user to approve, freezes the order after submission, and supports rejection', async () => {
    const b = await buying();
    const both = await staff(ctx.app, b.org.auth, ['procurement.create', 'procurement.approve', 'procurement.read'], { type: 'location', id: b.w1 });
    const po = await cmd(ctx.app, both.auth, '/v1/procurement/purchase-orders', poBody(b, [fabricLine(b)]));
    const id = po.body.id;
    await cmd(ctx.app, both.auth, poPath(id, '/submit'), {});
    expect((await cmd(ctx.app, both.auth, poPath(id, '/approve'), {})).status).toBe(403);
    expect((await cmd(ctx.app, b.buyer.auth, poPath(id, '/approve'), {})).status).toBe(403);
    expect((await call(ctx.app, 'PUT', poPath(id), both.auth, { note: 'sneaky' })).status).toBe(409);

    expect((await cmd(ctx.app, b.approver.auth, poPath(id, '/reject'), {})).status).toBe(400);
    const rej = await cmd(ctx.app, b.approver.auth, poPath(id, '/reject'), { note: 'Price too high' });
    expect(rej.body).toMatchObject({ status: 'draft', decisionNote: 'Price too high' });
    const edited = await call(ctx.app, 'PUT', poPath(id), both.auth, { lines: [fabricLine(b, '100', '11')], note: 'Renegotiated' });
    expect(edited.body).toMatchObject({ totalMinor: 110000, note: 'Renegotiated', status: 'draft' });
    await cmd(ctx.app, both.auth, poPath(id, '/submit'), {});
    const ok = await cmd(ctx.app, b.approver.auth, poPath(id, '/approve'), { note: 'ok' });
    expect(ok.body).toMatchObject({ status: 'approved', decidedBy: b.approver.userId });
    expect((await cmd(ctx.app, b.approver.auth, poPath(id, '/approve'), {})).status).toBe(409);
  });

  it('cancels before receipt but not after', async () => {
    const b = await buying();
    const po = await approvedPo(b);
    const cancelled = await cmd(ctx.app, b.buyer.auth, poPath(po.id, '/cancel'), {});
    expect(cancelled.body.status).toBe('cancelled');
    expect((await receive(b, po.id, [{ poLineId: po.lines[0].id, quantity: '10' }])).status).toBe(409);

    const po2 = await approvedPo(b);
    await receive(b, po2.id, [{ poLineId: po2.lines[0].id, quantity: '10' }]);
    expect((await cmd(ctx.app, b.buyer.auth, poPath(po2.id, '/cancel'), {})).status).toBe(409);
  });
});

describe('receiving', () => {
  it('stocks accepted goods, tracks partial and full receipt, and numbers receipts without gaps', async () => {
    const b = await buying();
    const po = await approvedPo(b);
    const line = po.lines[0].id;
    expect((await receive(b, po.id, [{ poLineId: line, quantity: '40' }])).body.status).toBe('partially_received');
    expect(await fabricStock(b)).toMatchObject({ quantity: '40' });

    // A failed receipt rolls back completely and does not burn a GRN number.
    const over = await receive(b, po.id, [{ poLineId: line, quantity: '61' }]);
    expect(over.status).toBe(409);
    expect((await fabricStock(b)).quantity).toBe('40');

    const done = await receive(b, po.id, [{ poLineId: line, quantity: '60' }]);
    expect(done.body.status).toBe('received');
    expect(done.body.lines[0]).toMatchObject({ receivedQuantity: '100', outstandingQuantity: '0' });
    expect(done.body.receipts.map((r: any) => r.receiptNumber)).toEqual(['GRN-000001', 'GRN-000002']);
    expect((await fabricStock(b)).quantity).toBe('100');
    expect((await receive(b, po.id, [{ poLineId: line, quantity: '1' }])).status).toBe(409);
    expect((await reconciled(ctx.app, b.org.auth)).consistent).toBe(true);
    const moves = await call(ctx.app, 'GET', `/v1/inventory/movements?variantId=${b.fabric.variantId}`, b.store.auth);
    expect(moves.body).toHaveLength(2);
    expect(moves.body[0]).toMatchObject({ type: 'receipt', referenceType: 'goods_receipt' });
  });

  it('only receives against approved orders, at a location the receiver covers', async () => {
    const b = await buying();
    const draft = await cmd(ctx.app, b.buyer.auth, '/v1/procurement/purchase-orders', poBody(b, [fabricLine(b)]));
    const line = draft.body.lines[0].id;
    expect((await receive(b, draft.body.id, [{ poLineId: line, quantity: '1' }])).status).toBe(409);
    const po = await approvedPo(b);
    const elsewhere = await staff(ctx.app, b.org.auth, ['procurement.receive'], { type: 'location', id: b.w2 });
    expect((await receive(b, po.id, [{ poLineId: po.lines[0].id, quantity: '1' }], elsewhere.auth)).status).toBe(403);
    expect((await receive(b, po.id, [{ poLineId: po.lines[0].id, quantity: '1' }], b.buyer.auth)).status).toBe(403);
  });

  it('allows over-receipt only within the order tolerance', async () => {
    const b = await buying();
    const po = await approvedPo(b, [fabricLine(b)], { overReceiptToleranceBps: 1000 });
    const line = po.lines[0].id;
    expect((await receive(b, po.id, [{ poLineId: line, quantity: '110.01' }])).status).toBe(409);
    const ok = await receive(b, po.id, [{ poLineId: line, quantity: '110' }]);
    expect(ok.status).toBe(201);
    expect(ok.body.status).toBe('received');
    expect((await fabricStock(b)).quantity).toBe('110');
  });

  it('records rejected goods without stocking them or counting them as received', async () => {
    const b = await buying();
    const po = await approvedPo(b);
    const line = po.lines[0].id;
    expect((await receive(b, po.id, [{ poLineId: line, rejectedQuantity: '5' }])).status).toBe(422);
    const r = await receive(b, po.id, [{ poLineId: line, quantity: '20', rejectedQuantity: '5', rejectReason: 'Water damage' }]);
    expect(r.body.lines[0]).toMatchObject({ receivedQuantity: '20', outstandingQuantity: '80' });
    expect((await fabricStock(b)).quantity).toBe('20');
    const rows = await ctx.db.query('SELECT quantity, rejected_quantity, reject_reason FROM goods_receipt_lines');
    expect(rows.rows.some((x) => x.reject_reason === 'Water damage' && Number(x.rejected_quantity) === 5)).toBe(true);
    expect((await receive(b, po.id, [{ poLineId: line }])).status).toBe(422);

    // A delivery that is rejected in full is recorded and stocks nothing.
    const allBad = await receive(b, po.id, [{ poLineId: line, rejectedQuantity: '30', rejectReason: 'Mouldy' }]);
    expect(allBad.status).toBe(201);
    expect(allBad.body.lines[0]).toMatchObject({ receivedQuantity: '20', outstandingQuantity: '80' });
    expect((await fabricStock(b)).quantity).toBe('20');
    const bad = await ctx.db.query("SELECT quantity, rejected_quantity FROM goods_receipt_lines WHERE reject_reason = 'Mouldy'");
    expect(bad.rows.map((r) => [Number(r.quantity), Number(r.rejected_quantity)])).toEqual([[0, 30]]);
    const moves = await call(ctx.app, 'GET', `/v1/inventory/movements?variantId=${b.fabric.variantId}`, b.store.auth);
    expect(moves.body).toHaveLength(1);
  });

  it('converts receipt units and requires lot codes for tracked goods', async () => {
    const b = await buying();
    const po = await approvedPo(b, [fabricLine(b, '100'), { variantId: b.rolled.variantId, quantity: '200', unitPrice: '7' }]);
    const [fabric, rolled] = po.lines;
    expect((await receive(b, po.id, [{ poLineId: fabric.id, quantity: '1', unitId: b.roll }])).status).toBe(201);
    expect((await fabricStock(b)).quantity).toBe('50');

    expect((await receive(b, po.id, [{ poLineId: rolled.id, quantity: '100' }])).status).toBe(422);
    const rolls = await receive(b, po.id, [
      { poLineId: rolled.id, quantity: '100', lotCode: 'MILL-A1' },
      { poLineId: rolled.id, quantity: '100', lotCode: 'MILL-A2' },
    ]);
    expect(rolls.status).toBe(201);
    const lots = await call(ctx.app, 'GET', `/v1/inventory/lots?variantId=${b.rolled.variantId}`, b.org.auth);
    expect(lots.body.map((l: any) => l.code).sort()).toEqual(['MILL-A1', 'MILL-A2']);
    expect(rolls.body.lines[1].receivedQuantity).toBe('200');
    expect((await receive(b, po.id, [{ poLineId: rolled.id, quantity: '1', lotCode: 'MILL-A1' }])).status).toBe(409);
  });

  it('never over-receives when deliveries are recorded concurrently', async () => {
    const b = await buying();
    const po = await approvedPo(b, [fabricLine(b, '30')]);
    const line = po.lines[0].id;
    const results = await Promise.all(Array.from({ length: 10 }, () => receive(b, po.id, [{ poLineId: line, quantity: '10' }])));
    expect(results.filter((r) => r.status === 201)).toHaveLength(3);
    expect(results.filter((r) => r.status === 409)).toHaveLength(7);
    expect((await fabricStock(b)).quantity).toBe('30');
    const final = await call(ctx.app, 'GET', poPath(po.id), b.store.auth);
    expect(final.body.status).toBe('received');
    expect(final.body.receipts.map((r: any) => r.receiptNumber)).toEqual(['GRN-000001', 'GRN-000002', 'GRN-000003']);
  });

  it('records a replayed receipt once', async () => {
    const b = await buying();
    const po = await approvedPo(b);
    const key = 'grn-replay-0001';
    const results = await Promise.all(Array.from({ length: 5 }, () => receive(b, po.id, [{ poLineId: po.lines[0].id, quantity: '10' }], b.store.auth, key)));
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect((await fabricStock(b)).quantity).toBe('10');
    expect(results[0]!.body.receipts).toHaveLength(1);
  });

  it('can be closed when the rest will not arrive', async () => {
    const b = await buying();
    const po = await approvedPo(b);
    await receive(b, po.id, [{ poLineId: po.lines[0].id, quantity: '40' }]);
    expect((await cmd(ctx.app, b.buyer.auth, poPath(po.id, '/close'), {})).status).toBe(403);
    const closed = await cmd(ctx.app, b.approver.auth, poPath(po.id, '/close'), {});
    expect(closed.body.status).toBe('closed');
    expect((await receive(b, po.id, [{ poLineId: po.lines[0].id, quantity: '1' }])).status).toBe(409);
    expect((await cmd(ctx.app, b.approver.auth, poPath(po.id, '/close'), {})).status).toBe(409);
  });
});

describe('supplier returns', () => {
  it('sends received stock back, capped at what was received and still held', async () => {
    const b = await buying();
    const po = await approvedPo(b);
    const line = po.lines[0].id;
    await receive(b, po.id, [{ poLineId: line, quantity: '40' }]);
    const ret = (lines: unknown[]) => cmd(ctx.app, b.store.auth, poPath(po.id, '/returns'), { reason: 'Wrong shade delivered', lines });

    const ok = await ret([{ poLineId: line, quantity: '15' }]);
    expect(ok.status).toBe(201);
    expect(ok.body.returnNumber).toBe('RTS-000001');
    expect(ok.body.purchaseOrder.lines[0]).toMatchObject({ receivedQuantity: '40', returnedQuantity: '15' });
    expect((await fabricStock(b)).quantity).toBe('25');
    expect((await ret([{ poLineId: line, quantity: '25.01' }])).status).toBe(409);

    // Stock that has already been sold cannot be returned.
    await cmd(ctx.app, b.org.auth, '/v1/inventory/issues', { locationId: b.w1, reasonCode: 'sale', lines: [{ variantId: b.fabric.variantId, quantity: '20' }] });
    expect((await ret([{ poLineId: line, quantity: '10' }])).status).toBe(409);
    expect((await fabricStock(b)).quantity).toBe('5');
    const noPerm = await cmd(ctx.app, b.buyer.auth, poPath(po.id, '/returns'), { reason: 'Wrong shade delivered', lines: [{ poLineId: line, quantity: '1' }] });
    expect(noPerm.status).toBe(403);
    expect((await reconciled(ctx.app, b.org.auth)).consistent).toBe(true);
  });

  it('returns a specific roll for tracked goods', async () => {
    const b = await buying();
    const po = await approvedPo(b, [{ variantId: b.rolled.variantId, quantity: '100', unitPrice: '7' }]);
    const r = await receive(b, po.id, [{ poLineId: po.lines[0].id, quantity: '100', lotCode: 'BAD-ROLL' }]);
    expect(r.status).toBe(201);
    const lot = (await call(ctx.app, 'GET', `/v1/inventory/lots?variantId=${b.rolled.variantId}`, b.org.auth)).body[0].id;
    const body = (lotId?: string) => ({ reason: 'Defective roll', lines: [{ poLineId: po.lines[0].id, quantity: '100', ...(lotId ? { lotId } : {}) }] });
    expect((await cmd(ctx.app, b.store.auth, poPath(po.id, '/returns'), body())).status).toBe(422);
    expect((await cmd(ctx.app, b.store.auth, poPath(po.id, '/returns'), body(lot))).status).toBe(201);
    expect((await balance(ctx.app, b.org.auth, { locationId: b.w1, variantId: b.rolled.variantId, lotId: lot })).quantity).toBe('0');
  });
});

describe('reporting and access', () => {
  it('reports quantity still on order from open orders only', async () => {
    const b = await buying();
    const open = await approvedPo(b, [fabricLine(b, '100')]);
    await receive(b, open.id, [{ poLineId: open.lines[0].id, quantity: '40' }]);
    const closed = await approvedPo(b, [fabricLine(b, '500')]);
    await cmd(ctx.app, b.buyer.auth, poPath(closed.id, '/cancel'), {});
    await cmd(ctx.app, b.buyer.auth, '/v1/procurement/purchase-orders', poBody(b, [fabricLine(b, '900')])); // draft, not counted
    const r = await call(ctx.app, 'GET', `/v1/procurement/on-order?variantId=${b.fabric.variantId}`, b.store.auth);
    expect(r.body).toEqual([{ locationId: b.w1, variantId: b.fabric.variantId, onOrder: '60' }]);
    await cmd(ctx.app, b.approver.auth, poPath(open.id, '/close'), {});
    expect((await call(ctx.app, 'GET', '/v1/procurement/on-order', b.store.auth)).body).toEqual([]);
  });

  it('keeps organizations and locations apart', async () => {
    const b = await buying();
    const other = await buying();
    const po = await approvedPo(b);
    expect((await call(ctx.app, 'GET', poPath(po.id), other.org.auth)).status).toBe(404);
    expect((await call(ctx.app, 'GET', '/v1/procurement/purchase-orders', other.org.auth)).body).toEqual([]);
    const foreign = await cmd(ctx.app, other.buyer.auth, '/v1/procurement/purchase-orders', { supplierId: b.supplier, destinationLocationId: other.w1, lines: [fabricLine(other)] });
    expect(foreign.status).toBe(404);
    const elsewhere = await staff(ctx.app, b.org.auth, ['procurement.read'], { type: 'location', id: b.w2 });
    expect((await call(ctx.app, 'GET', poPath(po.id), elsewhere.auth)).status).toBe(403);
    expect((await call(ctx.app, 'GET', '/v1/procurement/purchase-orders', elsewhere.auth)).body).toEqual([]);
    const listed = await call(ctx.app, 'GET', '/v1/procurement/purchase-orders?status=approved', b.buyer.auth);
    expect(listed.body.map((p: any) => p.id)).toContain(po.id);
  });

  it('audits order and receipt actions', async () => {
    const b = await buying();
    const po = await approvedPo(b);
    await receive(b, po.id, [{ poLineId: po.lines[0].id, quantity: '10' }]);
    const log = await call(ctx.app, 'GET', `/v1/audit-log?entityType=purchase_order&entityId=${po.id}`, b.org.auth);
    expect(log.body.map((e: any) => e.action).sort()).toEqual(['po.approve', 'po.create', 'po.submit']);
    const grn = await call(ctx.app, 'GET', '/v1/audit-log?entityType=goods_receipt', b.org.auth);
    expect(grn.body[0]).toMatchObject({ action: 'po.receive', actorUserId: b.store.userId });
  });
});
