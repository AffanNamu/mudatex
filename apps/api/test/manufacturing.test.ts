import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, newOrg, setupApp, staff } from './helpers.js';
import { balance, buildWorld, cmd, reconciled, type World } from './inventory-helpers.js';
import { bomPayload, buildMfg, comp, issueAll, makeBom, newProduct, runOps, stockUp, woCreate, woPost, type Mfg } from './manufacturing-helpers.js';

let ctx: Awaited<ReturnType<typeof setupApp>>;
beforeAll(async () => { ctx = await setupApp(); });
afterAll(async () => { await ctx.close(); });

const mfg = async () => buildMfg(ctx.app, await buildWorld(ctx.app, await newOrg(ctx.db)));
const stock = (m: Mfg, variantId: string, lotId?: string) => balance(ctx.app, m.base.org.auth, { locationId: m.base.w1, variantId, lotId });
/** On-hand total across every lot of a variant at the warehouse. */
const total = async (m: Mfg, variantId: string) => {
  const r = await call(ctx.app, 'GET', `/v1/inventory/balances?locationId=${m.base.w1}&variantId=${variantId}&state=on_hand`, m.base.org.auth);
  return r.body.reduce((a: number, b: any) => a + Number(b.quantity), 0) as number;
};
const released = async (m: Mfg, bomId: string, qty = '100', extra: Record<string, unknown> = {}) => {
  const wo = await woCreate(ctx.app, m, bomId, qty, extra);
  expect(wo.status).toBe(201);
  const rel = await woPost(ctx.app, m.planner.auth, wo.body.id, 'release');
  expect(rel.status).toBe(200);
  return rel.body;
};

describe('bills of materials', () => {
  it('are versioned, approved by someone else, and frozen once active', async () => {
    const m = await mfg();
    const out = await newProduct(ctx.app, m, 'Shirt', m.pcs, 'lot');
    const v1 = await cmd(ctx.app, m.bomMaker.auth, '/v1/manufacturing/boms', bomPayload(m, out));
    expect(v1.body).toMatchObject({ version: 1, status: 'draft', outputQuantity: '1' });
    expect(v1.body.components.map((c: any) => c.quantity)).toEqual(['2.5', '6', '40']);

    const edited = await call(ctx.app, 'PUT', `/v1/manufacturing/boms/${v1.body.id}`, m.bomMaker.auth, { ...bomPayload(m, out), note: 'Tweaked' });
    expect(edited.body.note).toBe('Tweaked');
    const both = await staff(ctx.app, m.base.org.auth, ['manufacturing.bom.manage', 'manufacturing.bom.approve'], { type: 'group' });
    const own = await cmd(ctx.app, both.auth, '/v1/manufacturing/boms', bomPayload(m, out));
    expect((await cmd(ctx.app, both.auth, `/v1/manufacturing/boms/${own.body.id}/approve`, {})).status).toBe(403);
    expect((await cmd(ctx.app, m.bomMaker.auth, `/v1/manufacturing/boms/${v1.body.id}/approve`, {})).status).toBe(403);

    const ok = await cmd(ctx.app, m.bomApprover.auth, `/v1/manufacturing/boms/${v1.body.id}/approve`, {});
    expect(ok.body).toMatchObject({ status: 'active', approvedBy: m.bomApprover.userId });
    expect((await call(ctx.app, 'PUT', `/v1/manufacturing/boms/${v1.body.id}`, m.bomMaker.auth, bomPayload(m, out))).status).toBe(409);
    await expect(ctx.db.query('UPDATE bom_components SET quantity = 1 WHERE bom_id = $1', [v1.body.id])).rejects.toThrow(/frozen/);
    await expect(ctx.db.query('DELETE FROM bom_operations WHERE bom_id = $1', [v1.body.id])).rejects.toThrow(/frozen/);
    await expect(ctx.db.query('UPDATE boms SET output_quantity = 5 WHERE id = $1', [v1.body.id])).rejects.toThrow(/frozen/);

    // A new version replaces the active one; the old one is retired but intact.
    const v3 = await cmd(ctx.app, m.bomMaker.auth, '/v1/manufacturing/boms', bomPayload(m, out));
    expect(v3.body.version).toBe(3);                                  // version 2 is the draft made by the other user above
    await cmd(ctx.app, m.bomApprover.auth, `/v1/manufacturing/boms/${v3.body.id}/approve`, {});
    const list = await call(ctx.app, 'GET', `/v1/manufacturing/boms?outputVariantId=${out}`, m.planner.auth);
    expect(list.body.map((b: any) => [b.version, b.status])).toEqual([[3, 'active'], [2, 'draft'], [1, 'retired']]);
    expect((await call(ctx.app, 'GET', `/v1/manufacturing/boms/${v1.body.id}`, m.planner.auth)).body.components).toHaveLength(3);
  });

  it('reject bad structure: self-reference, duplicates, QC without a trackable output, unknown work centres', async () => {
    const m = await mfg();
    const out = await newProduct(ctx.app, m, 'Shirt', m.pcs, 'lot');
    const post = (body: unknown) => cmd(ctx.app, m.bomMaker.auth, '/v1/manufacturing/boms', body);
    const base = bomPayload(m, out);
    expect((await post({ ...base, components: [...base.components, { variantId: out, quantity: '1' }] })).status).toBe(422);
    expect((await post({ ...base, components: [...base.components, { variantId: m.thread, quantity: '1' }] })).status).toBe(422);
    const plain = await newProduct(ctx.app, m, 'Plain', m.pcs, 'none');
    expect((await post({ ...bomPayload(m, plain), requiresQc: true })).status).toBe(422);
    expect((await post({ ...base, operations: [{ opNo: 10, name: 'X', workCentreId: crypto.randomUUID() }] })).status).toBe(422);
    expect((await post({ ...base, byproducts: [{ variantId: out, quantity: '1' }] })).status).toBe(422);
    expect((await post({ ...base, components: [] })).status).toBe(400);
    const noPerm = await cmd(ctx.app, m.planner.auth, '/v1/manufacturing/boms', base);
    expect(noPerm.status).toBe(403);
  });

  it('refuse a product that would end up inside its own bill of materials, at any depth', async () => {
    const m = await mfg();
    const a = await newProduct(ctx.app, m, 'Shirt', m.pcs, 'lot');
    const b = await newProduct(ctx.app, m, 'Panel', m.pcs, 'lot');
    const mk = async (out: string, comps: string[]) => {
      const d = await cmd(ctx.app, m.bomMaker.auth, '/v1/manufacturing/boms', { outputVariantId: out, outputQuantity: '1', components: comps.map((c) => ({ variantId: c, quantity: '1' })) });
      return d.body.id as string;
    };
    const bomA = await mk(a, [b]);                    // shirt needs a panel
    expect((await cmd(ctx.app, m.bomApprover.auth, `/v1/manufacturing/boms/${bomA}/approve`, {})).status).toBe(200);
    const bomB = await mk(b, [a]);                    // panel needs a shirt: cycle
    const bad = await cmd(ctx.app, m.bomApprover.auth, `/v1/manufacturing/boms/${bomB}/approve`, {});
    expect(bad.status).toBe(422);
    expect(bad.body.message).toMatch(/own bill of materials/);
  });
});

describe('requirements (MRP-lite)', () => {
  it('shows shortages and what open purchase orders will cover', async () => {
    const m = await mfg();
    const { bomId } = await makeBom(ctx.app, m);
    await stockUp(ctx.app, m, { cloth: [['R1', '100']] });
    const req = () => call(ctx.app, 'GET', `/v1/manufacturing/requirements?bomId=${bomId}&quantity=100&locationId=${m.base.w1}`, m.planner.auth);
    const r1 = await req();
    const cloth = r1.body.lines.find((l: any) => l.variantId === m.cloth);
    expect(cloth).toMatchObject({ required: '262.5', available: '100', shortage: '162.5', onOrder: '0', shortageAfterOnOrder: '162.5' });
    expect(r1.body).toMatchObject({ canRelease: false, fullyCoveredByOnOrder: false });
    expect(r1.body.lines.find((l: any) => l.variantId === m.button.variantId)).toMatchObject({ required: '600', shortage: '0' });

    const sup = await call(ctx.app, 'POST', '/v1/procurement/suppliers', m.base.org.auth, { code: 'MILL', name: 'Mill', countryCode: 'CN', defaultCurrency: 'USD' });
    const po = await cmd(ctx.app, m.base.org.auth, '/v1/procurement/purchase-orders', { supplierId: sup.body.id, destinationLocationId: m.base.w1, lines: [{ variantId: m.cloth, quantity: '200', unitPrice: '3' }] });
    const approver = await staff(ctx.app, m.base.org.auth, ['procurement.approve'], { type: 'location', id: m.base.w1 });
    await cmd(ctx.app, m.base.org.auth, `/v1/procurement/purchase-orders/${po.body.id}/submit`, {});
    await cmd(ctx.app, approver.auth, `/v1/procurement/purchase-orders/${po.body.id}/approve`, {});
    const r2 = await req();
    expect(r2.body.lines.find((l: any) => l.variantId === m.cloth)).toMatchObject({ onOrder: '200', shortageAfterOnOrder: '0' });
    expect(r2.body).toMatchObject({ canRelease: false, fullyCoveredByOnOrder: true });
  });
});

describe('labels for readers', () => {
  it('names products, lots and work centres on BOMs, work orders and lot lists, and shows holds', async () => {
    const m = await mfg();
    const lots = await stockUp(ctx.app, m);
    const { bomId } = await makeBom(ctx.app, m);
    const bom = await call(ctx.app, 'GET', `/v1/manufacturing/boms/${bomId}`, m.planner.auth);
    expect(bom.body).toMatchObject({ outputProductName: 'Shirt', outputSku: expect.stringMatching(/^Shirt-/) });
    expect(bom.body.components[0]).toMatchObject({ productName: 'Rolled', sku: expect.any(String) });
    expect(bom.body.operations[0]).toMatchObject({ workCentreName: 'CUT' });
    const list = await call(ctx.app, 'GET', '/v1/manufacturing/boms', m.planner.auth);
    expect(list.body[0]).toMatchObject({ outputProductName: 'Shirt', outputQuantity: '1', createdBy: m.bomMaker.userId });

    const wo = await released(m, bomId, '10');
    const cloth = wo.components.find((c: any) => c.variantId === m.cloth);
    expect(cloth).toMatchObject({ productName: 'Rolled', tracking: 'roll' });
    expect(cloth.allocations).toEqual([expect.objectContaining({ lotCode: 'R1', quantity: '26.25', issuedQuantity: '0' })]);
    expect(wo.operations[0]).toMatchObject({ workCentreName: 'CUT' });
    const woList = await call(ctx.app, 'GET', '/v1/manufacturing/work-orders', m.planner.auth);
    expect(woList.body[0]).toMatchObject({ outputProductName: 'Shirt' });

    await cmd(ctx.app, m.inspector.auth, `/v1/quality/lots/${lots.R2}/hold`, { reason: 'Colour fading suspected' });
    const lotList = await call(ctx.app, 'GET', '/v1/inventory/lots', m.base.org.auth);
    expect(lotList.body.find((l: any) => l.code === 'R2')).toMatchObject({ holdStatus: 'quarantined', holdReason: 'Colour fading suspected', productName: 'Rolled' });
    expect(lotList.body.find((l: any) => l.code === 'R1')).toMatchObject({ holdStatus: 'released' });
    const outsider = await staff(ctx.app, m.base.org.auth, ['catalog.read'], { type: 'group' });
    expect((await call(ctx.app, 'GET', '/v1/inventory/lots', outsider.auth)).status).toBe(403);
  });
});

describe('work order planning', () => {
  it('snapshots requirements and routing from the active BOM and numbers orders', async () => {
    const m = await mfg();
    const { bomId, variantId } = await makeBom(ctx.app, m);
    const wo = await woCreate(ctx.app, m, bomId, '100');
    expect(wo.body).toMatchObject({ woNumber: 'WO-000001', status: 'draft', plannedQuantity: '100', outputVariantId: variantId });
    expect(comp(wo.body, m.cloth).requiredQuantity).toBe('262.5');                 // 2.5 x 100 x 1.05
    expect(comp(wo.body, m.button.variantId).requiredQuantity).toBe('600');
    expect(comp(wo.body, m.thread).requiredQuantity).toBe('4400');                 // 40 x 100 x 1.10
    expect(wo.body.operations.map((o: any) => [o.opNo, o.plannedMinutes])).toEqual([[10, 260], [20, 400]]);
    expect((await woCreate(ctx.app, m, bomId, '10')).body.woNumber).toBe('WO-000002');

    // Later BOM versions do not change an order that already exists.
    const v2 = await cmd(ctx.app, m.bomMaker.auth, '/v1/manufacturing/boms', { ...bomPayload(m, variantId), components: [{ variantId: m.cloth, quantity: '9' }] });
    await cmd(ctx.app, m.bomApprover.auth, `/v1/manufacturing/boms/${v2.body.id}/approve`, {});
    const again = await call(ctx.app, 'GET', `/v1/manufacturing/work-orders/${wo.body.id}`, m.planner.auth);
    expect(comp(again.body, m.cloth).requiredQuantity).toBe('262.5');
    expect(again.body.bomId).toBe(bomId);
    expect((await woCreate(ctx.app, m, bomId, '5')).status).toBe(409);            // v1 is retired now
  });

  it('scales material up for expected yield and rounds up', async () => {
    const m = await mfg();
    const { bomId } = await makeBom(ctx.app, m, { yieldBps: 8000, ops: false });
    const wo = await woCreate(ctx.app, m, bomId, '100');
    expect(comp(wo.body, m.cloth).requiredQuantity).toBe('328.125');               // 262.5 / 0.8
    expect(wo.body.operations).toEqual([]);
  });

  it('needs permission, a draft BOM is refused, and routing must be at the production location', async () => {
    const m = await mfg();
    const { bomId } = await makeBom(ctx.app, m);
    expect((await woCreate(ctx.app, m, bomId, '10', {}, m.storeman.auth)).status).toBe(403);
    const draft = await cmd(ctx.app, m.bomMaker.auth, '/v1/manufacturing/boms', bomPayload(m, await newProduct(ctx.app, m, 'Other', m.pcs, 'lot')));
    expect((await woCreate(ctx.app, m, draft.body.id, '10')).status).toBe(409);
    const elsewhere = await staff(ctx.app, m.base.org.auth, ['manufacturing.plan'], { type: 'location', id: m.base.w2 });
    const wrongSite = await cmd(ctx.app, elsewhere.auth, '/v1/manufacturing/work-orders', { bomId, locationId: m.base.w2, quantity: '10' });
    expect(wrongSite.status).toBe(422);
  });
});

describe('releasing and reserving materials', () => {
  it('lists shortages and reserves nothing when material is missing', async () => {
    const m = await mfg();
    const { bomId } = await makeBom(ctx.app, m);
    await stockUp(ctx.app, m, { cloth: [['R1', '100']] });
    const wo = await woCreate(ctx.app, m, bomId, '100');
    const rel = await woPost(ctx.app, m.planner.auth, wo.body.id, 'release');
    expect(rel.status).toBe(409);
    expect(rel.body.error).toBe('shortage');
    expect(rel.body.details.shortages).toEqual([expect.objectContaining({ variantId: m.cloth, required: '262.5', available: '100', short: '162.5' })]);
    expect((await stock(m, m.thread)).reserved).toBe('0');
    expect((await call(ctx.app, 'GET', `/v1/manufacturing/work-orders/${wo.body.id}`, m.planner.auth)).body.status).toBe('draft');
  });

  it('allocates rolls oldest first, skips quarantined rolls, and keeps reserved stock from other orders', async () => {
    const m = await mfg();
    const { bomId } = await makeBom(ctx.app, m);
    const lots = await stockUp(ctx.app, m, { cloth: [['R0', '300'], ['R1', '150'], ['R2', '200']] });
    // R0 is the oldest but on hold, so it must be skipped.
    expect((await cmd(ctx.app, m.inspector.auth, `/v1/quality/lots/${lots.R0!}/hold`, { reason: 'Shade mismatch' })).status).toBe(200);
    const wo = await released(m, bomId);
    expect(comp(wo, m.cloth).allocatedQuantity).toBe('262.5');
    expect((await stock(m, m.cloth, lots.R1)).reserved).toBe('150');
    expect((await stock(m, m.cloth, lots.R2)).reserved).toBe('112.5');
    expect((await stock(m, m.cloth, lots.R0!)).reserved).toBe('0');
    expect(wo.status).toBe('released');

    // The reserved stock is not free for a second order.
    const wo2 = await woCreate(ctx.app, m, bomId, '100');
    const rel2 = await woPost(ctx.app, m.planner.auth, wo2.body.id, 'release');
    expect(rel2.status).toBe(409);
    expect(rel2.body.details.shortages[0]).toMatchObject({ variantId: m.cloth, available: '87.5' });
  });

  it('never over-reserves when orders are released at the same time', async () => {
    const m = await mfg();
    const { bomId } = await makeBom(ctx.app, m);
    await stockUp(ctx.app, m, { cloth: [['R1', '600']] });                     // enough cloth for two orders of 100, not three
    await cmd(ctx.app, m.base.org.auth, '/v1/inventory/receipts', { locationId: m.base.w1, lines: [{ variantId: m.button.variantId, quantity: '2000' }, { variantId: m.thread, quantity: '10000' }] });
    const orders = await Promise.all(Array.from({ length: 4 }, () => woCreate(ctx.app, m, bomId, '100')));
    const results = await Promise.all(orders.map((o) => woPost(ctx.app, m.planner.auth, o.body.id, 'release')));
    expect(results.filter((r) => r.status === 200)).toHaveLength(2);
    expect(results.filter((r) => r.status === 409)).toHaveLength(2);
    expect((await stock(m, m.cloth)).reserved).toBe('525');
    expect((await reconciled(ctx.app, m.base.org.auth)).consistent).toBe(true);
  });

  it('frees reservations when an unstarted order is cancelled', async () => {
    const m = await mfg();
    const { bomId } = await makeBom(ctx.app, m);
    await stockUp(ctx.app, m);
    const wo = await released(m, bomId);
    expect((await stock(m, m.thread)).reserved).toBe('4400');
    const cancelled = await woPost(ctx.app, m.planner.auth, wo.id, 'cancel');
    expect(cancelled.body.status).toBe('cancelled');
    expect((await stock(m, m.thread)).reserved).toBe('0');
    expect((await woPost(ctx.app, m.planner.auth, wo.id, 'release')).status).toBe(409);
  });
});

describe('issuing and returning material', () => {
  it('issues against the reservation and updates stock, allocation and component totals', async () => {
    const m = await mfg();
    const { bomId } = await makeBom(ctx.app, m);
    const lots = await stockUp(ctx.app, m);
    const wo = await released(m, bomId);
    const issued = await issueAll(ctx.app, m, wo, lots);
    expect(issued.status).toBe(201);
    expect(issued.body.status).toBe('in_progress');
    expect(comp(issued.body, m.cloth)).toMatchObject({ issuedQuantity: '262.5', returnedQuantity: '0' });
    expect(await stock(m, m.cloth, lots.R1)).toMatchObject({ quantity: '0', reserved: '0' });
    expect(await stock(m, m.cloth, lots.R2)).toMatchObject({ quantity: '87.5', reserved: '0' });
    expect(await stock(m, m.thread)).toMatchObject({ quantity: '600', reserved: '0' });
    const moves = await call(ctx.app, 'GET', `/v1/inventory/movements?referenceType=work_order&referenceId=${wo.id}&limit=50`, m.base.org.auth);
    expect(moves.body.every((x: any) => x.type === 'production_issue')).toBe(true);
    expect((await reconciled(ctx.app, m.base.org.auth)).consistent).toBe(true);
  });

  it('refuses issue beyond the reservation without an approved exception', async () => {
    const m = await mfg();
    const { bomId } = await makeBom(ctx.app, m);
    const lots = await stockUp(ctx.app, m);
    const wo = await released(m, bomId);
    const thread = comp(wo, m.thread).id;
    const over = (extra = {}, auth = m.storeman.auth) => woPost(ctx.app, auth, wo.id, 'issues', { lines: [{ componentId: thread, quantity: '4500', ...extra }] });
    expect((await over()).status).toBe(409);
    expect((await stock(m, m.thread)).quantity).toBe('5000');
    // A reason alone is not enough: the permission to approve exceptions is separate.
    expect((await over({ exceptionReason: 'Spoilage on the line' })).status).toBe(403);
    const ok = await over({ exceptionReason: 'Spoilage on the line' }, m.supervisor.auth);
    expect(ok.status).toBe(201);
    expect(comp(ok.body, m.thread).issuedQuantity).toBe('4500');
    expect(await stock(m, m.thread)).toMatchObject({ quantity: '500', reserved: '0' });
    const flagged = await ctx.db.query('SELECT quantity, is_exception, exception_reason FROM work_order_material_moves WHERE is_exception');
    expect(flagged.rows.map((r) => [Number(r.quantity), r.exception_reason])).toEqual([[100, 'Spoilage on the line']]);
    // Material from a roll nothing was reserved from is wholly an exception.
    const other = (await cmd(ctx.app, m.base.org.auth, '/v1/inventory/receipts', { locationId: m.base.w1, lines: [{ variantId: m.cloth, quantity: '50', lotCode: 'R9' }] })).body.lines[0].lotId;
    const cloth = comp(wo, m.cloth).id;
    expect((await woPost(ctx.app, m.storeman.auth, wo.id, 'issues', { lines: [{ componentId: cloth, lotId: other, quantity: '10' }] })).status).toBe(409);
    expect((await woPost(ctx.app, m.supervisor.auth, wo.id, 'issues', { lines: [{ componentId: cloth, lotId: other, quantity: '10', exceptionReason: 'Use up offcut roll' }] })).status).toBe(201);
    expect(lots.R1).toBeTruthy();
  });

  it('refuses a quarantined roll and replays an issue once', async () => {
    const m = await mfg();
    const { bomId } = await makeBom(ctx.app, m);
    const lots = await stockUp(ctx.app, m);
    const wo = await released(m, bomId);
    const line = { componentId: comp(wo, m.cloth).id, lotId: lots.R1, quantity: '50' };
    await cmd(ctx.app, m.inspector.auth, `/v1/quality/lots/${lots.R1}/hold`, { reason: 'Mildew found on roll' });
    const blocked = await woPost(ctx.app, m.storeman.auth, wo.id, 'issues', { lines: [line] });
    expect(blocked.status).toBe(409);
    expect(blocked.body.message).toMatch(/quarantined/);
    await cmd(ctx.app, m.supervisor.auth, `/v1/quality/lots/${lots.R1}/release`, { note: 'x' });   // supervisor lacks quality.release
    await cmd(ctx.app, (await staff(ctx.app, m.base.org.auth, ['quality.release'], { type: 'location', id: m.base.w1 })).auth, `/v1/quality/lots/${lots.R1}/release`, { note: 'Cleared after retest' });

    const key = 'issue-replay-0001';
    const results = await Promise.all(Array.from({ length: 5 }, () => woPost(ctx.app, m.storeman.auth, wo.id, 'issues', { lines: [line] }, key)));
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(comp(results[0]!.body, m.cloth).issuedQuantity).toBe('50');
    expect((await stock(m, m.cloth, lots.R1)).quantity).toBe('100');
  });

  it('only issues to released orders and checks permission', async () => {
    const m = await mfg();
    const { bomId } = await makeBom(ctx.app, m);
    await stockUp(ctx.app, m);
    const draft = await woCreate(ctx.app, m, bomId, '100');
    const line = { componentId: comp(draft.body, m.thread).id, quantity: '10' };
    expect((await woPost(ctx.app, m.storeman.auth, draft.body.id, 'issues', { lines: [line] })).status).toBe(409);
    const wo = await released(m, bomId, '10');
    expect((await woPost(ctx.app, m.operator.auth, wo.id, 'issues', { lines: [{ componentId: comp(wo, m.thread).id, quantity: '10' }] })).status).toBe(403);
  });

  it('takes unused material back, capped by what was issued from that roll', async () => {
    const m = await mfg();
    const { bomId } = await makeBom(ctx.app, m);
    const lots = await stockUp(ctx.app, m);
    const wo = await released(m, bomId);
    await issueAll(ctx.app, m, wo, lots);
    const ret = (lotId: string, quantity: string) => woPost(ctx.app, m.storeman.auth, wo.id, 'returns', { lines: [{ componentId: comp(wo, m.cloth).id, lotId, quantity }] });
    const ok = await ret(lots.R2!, '12.5');
    expect(ok.status).toBe(201);
    expect(comp(ok.body, m.cloth)).toMatchObject({ issuedQuantity: '262.5', returnedQuantity: '12.5' });
    expect((await stock(m, m.cloth, lots.R2!)).quantity).toBe('100');
    expect((await ret(lots.R2!, '100.01')).status).toBe(409);
    expect((await ret(lots.R1!, '151')).status).toBe(409);
    expect((await reconciled(ctx.app, m.base.org.auth)).consistent).toBe(true);
  });

  it('cannot cancel once material has been issued', async () => {
    const m = await mfg();
    const { bomId } = await makeBom(ctx.app, m);
    const lots = await stockUp(ctx.app, m);
    const wo = await released(m, bomId);
    await issueAll(ctx.app, m, wo, lots);
    expect((await woPost(ctx.app, m.planner.auth, wo.id, 'cancel')).status).toBe(409);
  });
});

describe('operations and output', () => {
  it('runs operations in sequence and records scrap and minutes', async () => {
    const m = await mfg();
    const { bomId } = await makeBom(ctx.app, m);
    const lots = await stockUp(ctx.app, m);
    const wo = await released(m, bomId);
    await issueAll(ctx.app, m, wo, lots);
    expect((await woPost(ctx.app, m.operator.auth, wo.id, 'operations/20/start')).status).toBe(409);       // cut first
    expect((await woPost(ctx.app, m.operator.auth, wo.id, 'operations/10/complete', { completedQuantity: '100' })).status).toBe(409);   // not started
    expect((await woPost(ctx.app, m.operator.auth, wo.id, 'operations/10/start')).status).toBe(200);
    expect((await woPost(ctx.app, m.operator.auth, wo.id, 'operations/10/start')).status).toBe(409);
    expect((await woPost(ctx.app, m.operator.auth, wo.id, 'operations/99/start')).status).toBe(404);
    expect((await woPost(ctx.app, m.storeman.auth, wo.id, 'operations/10/complete', { completedQuantity: '100' })).status).toBe(403);
    const done = await woPost(ctx.app, m.operator.auth, wo.id, 'operations/10/complete', { completedQuantity: '100', scrapQuantity: '3', minutes: 255.5 });
    expect(done.body.operations[0]).toMatchObject({ status: 'done', completedQuantity: '100', scrapQuantity: '3', actualMinutes: 255.5, plannedMinutes: 260 });
    expect((await woPost(ctx.app, m.operator.auth, wo.id, 'operations/20/start')).status).toBe(200);
  });

  it('receives output and declared by-products into stock, within the allowance', async () => {
    const m = await mfg();
    const { bomId, variantId } = await makeBom(ctx.app, m);
    const lots = await stockUp(ctx.app, m);
    const wo = await released(m, bomId, '100', { overProductionBps: 200 });
    await issueAll(ctx.app, m, wo, lots);
    const out = (body: unknown) => woPost(ctx.app, m.operator.auth, wo.id, 'outputs', body);

    expect((await out({ quantity: '40' })).status).toBe(422);                                            // lot-tracked: needs a lot code
    const first = await out({ quantity: '60', lotCode: 'SHIRT-A', byproducts: [{ variantId: m.offcut.variantId, quantity: '18' }] });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ producedQuantity: '60', status: 'in_progress' });
    expect(await total(m, variantId)).toBe(60);
    expect(await total(m, m.offcut.variantId)).toBe(18);
    expect(first.body.outputs.map((o: any) => [o.kind, o.quantity])).toEqual([['output', '60'], ['byproduct', '18']]);

    expect((await out({ quantity: '43', lotCode: 'SHIRT-B' })).status).toBe(409);                        // 103 > 102 allowed
    const undeclared = await out({ quantity: '1', lotCode: 'SHIRT-B', byproducts: [{ variantId: m.thread, quantity: '1' }] });
    expect(undeclared.status).toBe(422);
    expect((await out({ quantity: '42', lotCode: 'SHIRT-B' })).status).toBe(201);                        // 102 = 100 + 2%
    expect(await total(m, variantId)).toBe(102);
    expect((await reconciled(ctx.app, m.base.org.auth)).consistent).toBe(true);
  });

  it('holds QC-required output until a different person releases it', async () => {
    const m = await mfg();
    const { bomId, variantId } = await makeBom(ctx.app, m, { requiresQc: true });
    const lots = await stockUp(ctx.app, m);
    const wo = await released(m, bomId);
    await issueAll(ctx.app, m, wo, lots);
    // The producer is allowed to release lots in general, but not output they produced themselves.
    const producer = await staff(ctx.app, m.base.org.auth, ['manufacturing.operate', 'quality.release', 'manufacturing.read'], { type: 'location', id: m.base.w1 });
    const out = await woPost(ctx.app, producer.auth, wo.id, 'outputs', { quantity: '100', lotCode: 'SHIRT-QC' });
    expect(out.body.outputs[0]).toMatchObject({ lotCode: 'SHIRT-QC', holdStatus: 'quarantined' });
    const lotId = out.body.outputs[0].lotId;

    // Quarantined output cannot be issued, reserved or transferred.
    const issue = await cmd(ctx.app, m.base.org.auth, '/v1/inventory/issues', { locationId: m.base.w1, reasonCode: 'sale', lines: [{ variantId, lotId, quantity: '1' }] });
    expect(issue.status).toBe(409);
    expect(issue.body.message).toMatch(/quarantined/);
    expect((await cmd(ctx.app, m.base.org.auth, '/v1/inventory/reservations', { locationId: m.base.w1, variantId, lotId, quantity: '1', referenceType: 'order', referenceId: 'O' })).status).toBe(409);
    expect((await cmd(ctx.app, m.base.org.auth, '/v1/inventory/transfers', { sourceLocationId: m.base.w1, destinationLocationId: m.base.w2, lines: [{ variantId, lotId, quantity: '1' }] })).status).toBe(409);
    // New output cannot be mixed into an existing lot when QC applies.
    expect((await woPost(ctx.app, m.operator.auth, wo.id, 'outputs', { quantity: '1', lotCode: 'SHIRT-QC' })).status).toBe(409);

    expect((await cmd(ctx.app, producer.auth, `/v1/quality/lots/${lotId}/release`, { note: 'Self release' })).status).toBe(403);
    expect((await cmd(ctx.app, m.operator.auth, `/v1/quality/lots/${lotId}/release`, { note: 'No permission' })).status).toBe(403);
    const cleared = await cmd(ctx.app, m.inspector.auth, `/v1/quality/lots/${lotId}/release`, { note: 'Passed inspection' });
    expect(cleared.body.holdStatus).toBe('released');
    expect((await cmd(ctx.app, m.base.org.auth, '/v1/inventory/issues', { locationId: m.base.w1, reasonCode: 'sale', lines: [{ variantId, lotId, quantity: '1' }] })).status).toBe(201);
  });
});

describe('quality holds', () => {
  it('block every way stock can leave, need a different person to release, and still allow disposal', async () => {
    const m = await mfg();
    const lots = await stockUp(ctx.app, m);
    const a = m.base.org.auth;
    const v = m.cloth;
    const lotId = lots.R1!;
    const hold = (auth = m.inspector.auth) => cmd(ctx.app, auth, `/v1/quality/lots/${lotId}/hold`, { reason: 'Contamination suspected' });

    expect((await cmd(ctx.app, m.planner.auth, `/v1/quality/lots/${lotId}/hold`, { reason: 'Contamination suspected' })).status).toBe(403);
    const held = await hold();
    expect(held.body).toMatchObject({ holdStatus: 'quarantined' });
    expect((await hold()).status).toBe(409);

    // A reservation made before the hold cannot be fulfilled afterwards.
    const preHold = await staff(ctx.app, a, ['inventory.reserve', 'inventory.issue'], { type: 'location', id: m.base.w1 });
    const lots2 = await stockUp(ctx.app, m, { cloth: [['R7', '20']] });
    void lots2;
    const res = await cmd(ctx.app, preHold.auth, '/v1/inventory/reservations', { locationId: m.base.w1, variantId: v, lotId: lots2.R7!, quantity: '5', referenceType: 'order', referenceId: 'O-1' });
    await cmd(ctx.app, m.inspector.auth, `/v1/quality/lots/${lots2.R7!}/hold`, { reason: 'Contamination suspected' });
    expect((await cmd(ctx.app, preHold.auth, `/v1/inventory/reservations/${res.body.id}/fulfil`, {})).status).toBe(409);

    // Disposal is still possible: an approved adjustment can write the lot off.
    const maker = await staff(ctx.app, a, ['inventory.adjust'], { type: 'location', id: m.base.w1 });
    const adj = await cmd(ctx.app, maker.auth, '/v1/inventory/adjustments', { locationId: m.base.w1, reason: 'Scrap contaminated roll', lines: [{ variantId: v, lotId, direction: 'decrease', quantity: '150' }] });
    expect(adj.status).toBe(201);
    expect((await cmd(ctx.app, a, `/v1/inventory/adjustments/${adj.body.id}/approve`, {})).status).toBe(200);
    expect((await stock(m, v, lotId)).quantity).toBe('0');

    const releaser = await staff(ctx.app, a, ['quality.hold', 'quality.release'], { type: 'location', id: m.base.w1 });
    await cmd(ctx.app, releaser.auth, `/v1/quality/lots/${lots2.R7!}/release`, { note: 'Retest passed' }).then((r) => expect(r.status).toBe(200));
    const again = await staff(ctx.app, a, ['quality.hold', 'quality.release'], { type: 'location', id: m.base.w1 });
    await cmd(ctx.app, again.auth, `/v1/quality/lots/${lots2.R7!}/hold`, { reason: 'Second doubt raised' });
    expect((await cmd(ctx.app, again.auth, `/v1/quality/lots/${lots2.R7!}/release`, { note: 'Self release' })).status).toBe(403);
  });
});

describe('completing and closing', () => {
  async function produced(m: Mfg, extra: { qc?: boolean; overUseThread?: boolean } = {}) {
    const { bomId, variantId } = await makeBom(ctx.app, m, { requiresQc: extra.qc ?? false });
    const lots = await stockUp(ctx.app, m);
    const wo = await released(m, bomId);
    await issueAll(ctx.app, m, wo, lots);
    if (extra.overUseThread) {
      await woPost(ctx.app, m.supervisor.auth, wo.id, 'issues', { lines: [{ componentId: comp(wo, m.thread).id, quantity: '500', exceptionReason: 'Machine jam wasted thread' }] });
    }
    await runOps(ctx.app, m, wo.id);
    await woPost(ctx.app, m.operator.auth, wo.id, 'outputs', { quantity: '100', lotCode: 'SHIRT-1', byproducts: [{ variantId: m.offcut.variantId, quantity: '30' }] });
    return { wo, bomId, variantId, lots };
  }

  it('reconciles quantities and closes when inside tolerance', async () => {
    const m = await mfg();
    const { wo } = await produced(m);
    const done = await woPost(ctx.app, m.supervisor.auth, wo.id, 'complete');
    expect(done.body.status).toBe('completed');

    const rec = await call(ctx.app, 'GET', `/v1/manufacturing/work-orders/${wo.id}/reconciliation`, m.planner.auth);
    expect(rec.body.outsideTolerance).toBe(false);
    expect(rec.body.components.find((c: any) => c.variantId === m.cloth)).toMatchObject({ required: '262.5', issued: '262.5', netConsumed: '262.5', expectedForOutput: '262.5', variance: '0', status: 'within_tolerance' });
    expect(rec.body.output).toMatchObject({ planned: '100', produced: '100', yieldBps: 10000, scrapQuantity: '2' });
    expect(rec.body.byproducts).toEqual([{ variantId: m.offcut.variantId, quantity: '30' }]);
    expect(rec.body.minutes).toEqual({ planned: 660, actual: 665 });

    const closed = await woPost(ctx.app, m.supervisor.auth, wo.id, 'close');
    expect(closed.body.status).toBe('closed');
    expect(closed.body.reconciliation.outsideTolerance).toBe(false);
    expect((await woPost(ctx.app, m.storeman.auth, wo.id, 'issues', { lines: [{ componentId: comp(wo, m.thread).id, quantity: '1' }] })).status).toBe(409);
    expect((await woPost(ctx.app, m.supervisor.auth, wo.id, 'close')).status).toBe(409);
  });

  it('needs a variance reason when material use is outside tolerance', async () => {
    const m = await mfg();
    const { wo } = await produced(m, { overUseThread: true });
    await woPost(ctx.app, m.supervisor.auth, wo.id, 'complete');
    const blocked = await woPost(ctx.app, m.supervisor.auth, wo.id, 'close');
    expect(blocked.status).toBe(422);
    expect(blocked.body.error).toBe('variance_reason_required');
    expect(blocked.body.details.components.find((c: any) => c.variantId === m.thread)).toMatchObject({ netConsumed: '4900', expectedForOutput: '4400', variance: '500', status: 'over' });
    expect((await call(ctx.app, 'GET', `/v1/manufacturing/work-orders/${wo.id}`, m.planner.auth)).body.status).toBe('completed');
    const ok = await woPost(ctx.app, m.supervisor.auth, wo.id, 'close', { varianceReason: 'Machine jam wasted thread' });
    expect(ok.body).toMatchObject({ status: 'closed', varianceReason: 'Machine jam wasted thread' });
  });

  it('completes only an in-progress order with every operation done, and frees unissued reservations', async () => {
    const m = await mfg();
    const { bomId } = await makeBom(ctx.app, m);
    const lots = await stockUp(ctx.app, m);
    const wo = await released(m, bomId);
    expect((await woPost(ctx.app, m.supervisor.auth, wo.id, 'complete')).status).toBe(409);               // nothing started
    await woPost(ctx.app, m.storeman.auth, wo.id, 'issues', { lines: [{ componentId: comp(wo, m.button.variantId).id, quantity: '600' }] });
    expect((await woPost(ctx.app, m.supervisor.auth, wo.id, 'complete')).status).toBe(409);               // operations open
    expect((await woPost(ctx.app, m.operator.auth, wo.id, 'operations/10/start')).status).toBe(200);
    await woPost(ctx.app, m.operator.auth, wo.id, 'operations/10/complete', { completedQuantity: '100' });
    await woPost(ctx.app, m.operator.auth, wo.id, 'operations/20/start');
    await woPost(ctx.app, m.operator.auth, wo.id, 'operations/20/complete', { completedQuantity: '100' });
    expect((await stock(m, m.thread)).reserved).toBe('4400');
    expect((await woPost(ctx.app, m.planner.auth, wo.id, 'complete')).status).toBe(403);
    expect((await woPost(ctx.app, m.supervisor.auth, wo.id, 'complete')).status).toBe(200);
    expect((await stock(m, m.thread)).reserved).toBe('0');                                                // thread was never issued
    expect((await stock(m, m.cloth, lots.R1!)).reserved).toBe('0');
  });
});

describe('genealogy', () => {
  async function build() {
    const m = await mfg();
    const { bomId, variantId } = await makeBom(ctx.app, m);
    const lots = await stockUp(ctx.app, m);
    // Split R2 so that a child roll, not the parent, is what gets consumed.
    const split = await cmd(ctx.app, m.base.org.auth, `/v1/inventory/rolls/${lots.R2}/split`, { locationId: m.base.w1, children: [{ code: 'R2-A', quantity: '120' }] });
    const child = split.body.children[0].lotId as string;
    const wo = await released(m, bomId);
    return { m, bomId, variantId, lots, wo, child };
  }

  it('traces a finished lot back to the material rolls and operations, through roll splits', async () => {
    const { m, lots, wo, child } = await build();
    // The reservation took R1 (150) and the oldest free lot after it; issue what was allocated.
    const alloc = await ctx.db.query<{ lot_id: string; quantity: string }>('SELECT lot_id, quantity FROM work_order_allocations a JOIN work_order_components c ON c.id = a.component_id WHERE a.work_order_id = $1 AND c.variant_id = $2 ORDER BY quantity DESC', [wo.id, m.cloth]);
    const lines = alloc.rows.map((a) => ({ componentId: comp(wo, m.cloth).id, lotId: a.lot_id, quantity: normalizeQty(a.quantity) }));
    await woPost(ctx.app, m.storeman.auth, wo.id, 'issues', { lines: [...lines, { componentId: comp(wo, m.button.variantId).id, quantity: '600' }, { componentId: comp(wo, m.thread).id, quantity: '4400' }] });
    await runOps(ctx.app, m, wo.id);
    const out = await woPost(ctx.app, m.operator.auth, wo.id, 'outputs', { quantity: '100', lotCode: 'SHIRT-T' });
    const outLot = out.body.outputs[0].lotId;

    const back = await call(ctx.app, 'GET', `/v1/manufacturing/genealogy?lotId=${outLot}&direction=backward`, m.base.org.auth);
    expect(back.status).toBe(200);
    expect(back.body.lot.code).toBe('SHIRT-T');
    expect(back.body.workOrders).toHaveLength(1);
    const node = back.body.workOrders[0];
    expect(node).toMatchObject({ woNumber: wo.woNumber, depth: 1 });
    expect(node.operations.map((o: any) => [o.opNo, o.status])).toEqual([[10, 'done'], [20, 'done']]);
    const clothLots = node.consumed.filter((c: any) => c.variantId === m.cloth).map((c: any) => c.lotCode).sort();
    expect(clothLots).toContain('R1');
    expect(node.consumed.some((c: any) => c.lotId === child || c.lotCode === 'R1')).toBe(true);
    expect(back.body.materialLotIds.length).toBeGreaterThan(0);

    // Forward from the parent roll R2 reaches the work order that consumed it (or its child) and its output.
    const fwdR1 = await call(ctx.app, 'GET', `/v1/manufacturing/genealogy?lotId=${lots.R1}&direction=forward`, m.base.org.auth);
    expect(fwdR1.body.workOrders[0]).toMatchObject({ woNumber: wo.woNumber });
    expect(fwdR1.body.workOrders[0].outputs.map((o: any) => o.lotCode)).toContain('SHIRT-T');
    expect(fwdR1.body.affectedLotIds).toContain(outLot);

    expect((await call(ctx.app, 'GET', `/v1/manufacturing/genealogy?lotId=${outLot}&direction=backward`, m.planner.auth)).status).toBe(403);   // org-wide read needed
    expect((await call(ctx.app, 'GET', `/v1/manufacturing/genealogy?lotId=${crypto.randomUUID()}&direction=forward`, m.base.org.auth)).status).toBe(404);
  });

  it('finds work orders through a roll split in both directions', async () => {
    const { m, lots, wo, child } = await build();
    // Consume the CHILD roll through an exception issue so the link goes via lineage.
    await woPost(ctx.app, m.supervisor.auth, wo.id, 'issues', { lines: [{ componentId: comp(wo, m.cloth).id, lotId: child, quantity: '10', exceptionReason: 'Use cut piece first' }] });
    const fwd = await call(ctx.app, 'GET', `/v1/manufacturing/genealogy?lotId=${lots.R2}&direction=forward`, m.base.org.auth);
    expect(fwd.body.workOrders.map((w: any) => w.woNumber)).toContain(wo.woNumber);       // parent roll -> child consumed
    expect(fwd.body.affectedLotIds).toContain(child);
    await woPost(ctx.app, m.operator.auth, wo.id, 'outputs', { quantity: '10', lotCode: 'SHIRT-S' });
    const outLot = (await call(ctx.app, 'GET', `/v1/manufacturing/work-orders/${wo.id}`, m.planner.auth)).body.outputs[0].lotId;
    const back = await call(ctx.app, 'GET', `/v1/manufacturing/genealogy?lotId=${outLot}&direction=backward`, m.base.org.auth);
    expect(back.body.workOrders[0].consumed.map((c: any) => c.lotId)).toContain(child);
    expect(back.body.materialLotIds).toContain(lots.R2);                                  // ancestor of the consumed child
  });

  it('follows finished goods forward to retail sales', async () => {
    const m = await mfg();
    const { bomId, variantId } = await makeBom(ctx.app, m);
    const lots = await stockUp(ctx.app, m);
    const wo = await released(m, bomId, '10');
    const need = await ctx.db.query<{ lot_id: string; quantity: string }>('SELECT lot_id, quantity FROM work_order_allocations WHERE work_order_id = $1 AND lot_id IS NOT NULL', [wo.id]);
    await woPost(ctx.app, m.storeman.auth, wo.id, 'issues', { lines: [
      ...need.rows.map((a) => ({ componentId: comp(wo, m.cloth).id, lotId: a.lot_id, quantity: normalizeQty(a.quantity) })),
      { componentId: comp(wo, m.button.variantId).id, quantity: '60' }, { componentId: comp(wo, m.thread).id, quantity: '440' },
    ] });
    const out = await woPost(ctx.app, m.operator.auth, wo.id, 'outputs', { quantity: '10', lotCode: 'SHIRT-SOLD' });
    const outLot = out.body.outputs[0].lotId;

    // Move the shirts to the shop, price them and sell some.
    await cmd(ctx.app, m.base.org.auth, '/v1/inventory/transfers', { sourceLocationId: m.base.w1, destinationLocationId: m.base.shop, lines: [{ variantId, lotId: outLot, quantity: '10' }] })
      .then(async (t) => cmd(ctx.app, m.base.org.auth, `/v1/inventory/transfers/${t.body.id}/receive`, { lines: [{ lineId: t.body.lines[0].id, quantity: '10' }] }));
    const pl = await call(ctx.app, 'POST', '/v1/pricing/price-lists', m.base.org.auth, { legalEntityId: m.base.ng, name: 'Retail', currency: 'NGN' });
    await call(ctx.app, 'PUT', `/v1/pricing/price-lists/${pl.body.id}/items`, m.base.org.auth, { variantId, unitPrice: '5000' });
    const reg = await call(ctx.app, 'POST', '/v1/pos/registers', m.base.org.auth, { locationId: m.base.shop, code: 'MFG1', name: 'Shop', priceListId: pl.body.id });
    const cashier = await staff(ctx.app, m.base.org.auth, ['pos.sell', 'pos.session', 'pos.read'], { type: 'location', id: m.base.shop });
    await cmd(ctx.app, cashier.auth, `/v1/pos/registers/${reg.body.id}/sessions`, { openingFloatMinor: 0 });
    const sale = await cmd(ctx.app, cashier.auth, '/v1/pos/sales', { registerId: reg.body.id, lines: [{ variantId, lotId: outLot, quantity: '2' }], payments: [{ method: 'cash', amountMinor: 1000000 }] });
    expect(sale.status).toBe(201);

    const fwd = await call(ctx.app, 'GET', `/v1/manufacturing/genealogy?lotId=${lots.R1}&direction=forward`, m.base.org.auth);
    expect(fwd.body.sales).toEqual([expect.objectContaining({ receiptNumber: sale.body.receiptNumber, lotCode: 'SHIRT-SOLD', quantity: '2', status: 'completed' })]);
  });
});

describe('access', () => {
  it('keeps organizations and locations apart and audits manufacturing actions', async () => {
    const m = await mfg();
    const other = await mfg();
    const { bomId } = await makeBom(ctx.app, m);
    await stockUp(ctx.app, m);
    const wo = await released(m, bomId, '10');
    expect((await call(ctx.app, 'GET', `/v1/manufacturing/work-orders/${wo.id}`, other.planner.auth)).status).toBe(404);
    expect((await call(ctx.app, 'GET', '/v1/manufacturing/work-orders', other.planner.auth)).body).toEqual([]);
    expect((await woCreate(ctx.app, other, bomId, '10')).status).toBe(404);
    const w2 = await staff(ctx.app, m.base.org.auth, ['manufacturing.read'], { type: 'location', id: m.base.w2 });
    expect((await call(ctx.app, 'GET', `/v1/manufacturing/work-orders/${wo.id}`, w2.auth)).status).toBe(403);
    expect((await call(ctx.app, 'GET', '/v1/manufacturing/work-orders', w2.auth)).body).toEqual([]);
    const mine = await call(ctx.app, 'GET', '/v1/manufacturing/work-orders?status=released', m.planner.auth);
    expect(mine.body.map((x: any) => x.woNumber)).toEqual([wo.woNumber]);

    const log = await call(ctx.app, 'GET', `/v1/audit-log?entityType=work_order&entityId=${wo.id}`, m.base.org.auth);
    expect(log.body.map((e: any) => e.action).sort()).toEqual(['wo.create', 'wo.release']);
  });
});

function normalizeQty(q: string) {
  return q.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}
