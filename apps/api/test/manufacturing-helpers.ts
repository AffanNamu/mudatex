import type { FastifyInstance } from 'fastify';
import { call, staff, type Headers } from './helpers.js';
import { cmd, type World } from './inventory-helpers.js';

export interface Mfg {
  base: World;
  pcs: string;
  button: { productId: string; variantId: string };
  offcut: { productId: string; variantId: string };
  cloth: string;   // roll-tracked, yard
  thread: string;  // untracked, metre
  cut: string;
  sew: string;
  bomMaker: Awaited<ReturnType<typeof staff>>;
  bomApprover: Awaited<ReturnType<typeof staff>>;
  planner: Awaited<ReturnType<typeof staff>>;
  storeman: Awaited<ReturnType<typeof staff>>;
  operator: Awaited<ReturnType<typeof staff>>;
  supervisor: Awaited<ReturnType<typeof staff>>;
  inspector: Awaited<ReturnType<typeof staff>>;
}

export async function buildMfg(app: FastifyInstance, base: World): Promise<Mfg> {
  const a = base.org.auth;
  const pcs = (await call(app, 'POST', '/v1/units', a, { code: 'pcs', name: 'Pieces', kind: 'discrete', precision: 0 })).body.id as string;
  const product = async (name: string, baseUnitId: string, tracking = 'none') => {
    const r = await call(app, 'POST', '/v1/products', a, { name, baseUnitId, variants: [{ sku: `${name}-${crypto.randomUUID().slice(0, 6)}`, tracking }] });
    if (r.status !== 201) throw new Error(JSON.stringify(r.body));
    return { productId: r.body.id as string, variantId: r.body.variantIds[0] as string };
  };
  const wc = async (code: string) => (await call(app, 'POST', '/v1/manufacturing/work-centres', a, { locationId: base.w1, code, name: code })).body.id as string;
  const at = { type: 'location', id: base.w1 };
  const grp = { type: 'group' };
  return {
    base, pcs,
    button: await product('Button', pcs),
    offcut: await product('Offcut', base.m),
    cloth: base.rolled.variantId,
    thread: base.fabric.variantId,
    cut: await wc('CUT'),
    sew: await wc('SEW'),
    bomMaker: await staff(app, a, ['manufacturing.bom.manage', 'manufacturing.read'], grp),
    bomApprover: await staff(app, a, ['manufacturing.bom.approve', 'manufacturing.read'], grp),
    planner: await staff(app, a, ['manufacturing.plan', 'manufacturing.read', 'inventory.read'], at),
    storeman: await staff(app, a, ['manufacturing.issue', 'manufacturing.read'], at),
    operator: await staff(app, a, ['manufacturing.operate', 'manufacturing.read'], at),
    supervisor: await staff(app, a, ['manufacturing.close', 'manufacturing.issue', 'manufacturing.issue.exception', 'manufacturing.read'], at),
    inspector: await staff(app, a, ['quality.hold', 'quality.release', 'manufacturing.read'], at),
  };
}

export async function newProduct(app: FastifyInstance, m: Mfg, name: string, baseUnitId: string, tracking = 'none') {
  const r = await call(app, 'POST', '/v1/products', m.base.org.auth, { name, baseUnitId, variants: [{ sku: `${name}-${crypto.randomUUID().slice(0, 6)}`, tracking }] });
  return r.body.variantIds[0] as string;
}

export interface BomOpts {
  requiresQc?: boolean;
  tracking?: string;
  yieldBps?: number;
  ops?: boolean;
  byproduct?: boolean;
  extraComponents?: unknown[];
  outputVariantId?: string;
}

export function bomPayload(m: Mfg, outputVariantId: string, o: BomOpts = {}) {
  return {
    outputVariantId, outputQuantity: '1', expectedYieldBps: o.yieldBps ?? 10000, requiresQc: o.requiresQc ?? false,
    components: [
      { variantId: m.cloth, quantity: '2.5', scrapBps: 500 },
      { variantId: m.button.variantId, quantity: '6' },
      { variantId: m.thread, quantity: '40', scrapBps: 1000 },
      ...(o.extraComponents ?? []),
    ],
    byproducts: o.byproduct === false ? [] : [{ variantId: m.offcut.variantId, quantity: '0.3' }],
    operations: o.ops === false ? [] : [
      { opNo: 10, name: 'Cut', workCentreId: m.cut, setupMinutes: 10, runMinutesPerUnit: '2.5' },
      { opNo: 20, name: 'Sew', workCentreId: m.sew, setupMinutes: 0, runMinutesPerUnit: '4', qcCheckpoint: true },
    ],
  };
}

/** Creates a fresh garment product, drafts and approves a BOM for it. */
export async function makeBom(app: FastifyInstance, m: Mfg, o: BomOpts = {}) {
  const variantId = o.outputVariantId ?? (await newProduct(app, m, 'Shirt', m.pcs, o.tracking ?? 'lot'));
  const draft = await cmd(app, m.bomMaker.auth, '/v1/manufacturing/boms', bomPayload(m, variantId, o));
  if (draft.status !== 201) throw new Error(`bom draft failed: ${JSON.stringify(draft.body)}`);
  const ok = await cmd(app, m.bomApprover.auth, `/v1/manufacturing/boms/${draft.body.id}/approve`, {});
  if (ok.status !== 200) throw new Error(`bom approve failed: ${JSON.stringify(ok.body)}`);
  return { bomId: draft.body.id as string, variantId };
}

/** Stocks cloth rolls R1 (150 yd, older) and R2 (200 yd), buttons and thread at the warehouse. */
export async function stockUp(app: FastifyInstance, m: Mfg, extra: { cloth?: [string, string][] } = {}) {
  const a = m.base.org.auth;
  const lots: Record<string, string> = {};
  for (const [code, qty] of extra.cloth ?? [['R1', '150'], ['R2', '200']]) {
    const r = await cmd(app, a, '/v1/inventory/receipts', { locationId: m.base.w1, lines: [{ variantId: m.cloth, quantity: qty, lotCode: code }] });
    if (r.status !== 201) throw new Error(JSON.stringify(r.body));
    lots[code] = r.body.lines[0].lotId;
  }
  await cmd(app, a, '/v1/inventory/receipts', { locationId: m.base.w1, lines: [{ variantId: m.button.variantId, quantity: '1000' }, { variantId: m.thread, quantity: '5000' }] });
  return lots;
}

export const woCreate = (app: FastifyInstance, m: Mfg, bomId: string, quantity = '100', extra: Record<string, unknown> = {}, auth: Headers = m.planner.auth) =>
  cmd(app, auth, '/v1/manufacturing/work-orders', { bomId, locationId: m.base.w1, quantity, ...extra });

export const woPost = (app: FastifyInstance, auth: Headers, id: string, tail: string, body: unknown = {}, key?: string) =>
  cmd(app, auth, `/v1/manufacturing/work-orders/${id}/${tail}`, body, key);

export const comp = (wo: any, variantId: string) => wo.components.find((c: any) => c.variantId === variantId);

/** Issues the full allocation of every component, as the storeman would. */
export async function issueAll(app: FastifyInstance, m: Mfg, wo: any, lots: Record<string, string>, clothSplit: [string, string][] = [['R1', '150'], ['R2', '112.5']]) {
  const lines = [
    ...clothSplit.map(([code, quantity]) => ({ componentId: comp(wo, m.cloth).id, lotId: lots[code], quantity })),
    { componentId: comp(wo, m.button.variantId).id, quantity: '600' },
    { componentId: comp(wo, m.thread).id, quantity: '4400' },
  ];
  return woPost(app, m.storeman.auth, wo.id, 'issues', { lines });
}

export async function runOps(app: FastifyInstance, m: Mfg, woId: string) {
  for (const n of [10, 20]) {
    await woPost(app, m.operator.auth, woId, `operations/${n}/start`);
    const r = await woPost(app, m.operator.auth, woId, `operations/${n}/complete`, { completedQuantity: '100', scrapQuantity: n === 20 ? '2' : '0', minutes: n === 10 ? 255 : 410 });
    if (r.status !== 200) throw new Error(JSON.stringify(r.body));
  }
}
