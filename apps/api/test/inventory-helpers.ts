import type { FastifyInstance } from 'fastify';
import { call, newOrg, staff, type Headers } from './helpers.js';

export type Org = Awaited<ReturnType<typeof newOrg>>;

/** POST with a fresh (or supplied) Idempotency-Key. */
export function cmd(app: FastifyInstance, auth: Headers, path: string, body: unknown, key: string = crypto.randomUUID()) {
  return call(app, 'POST', path, { ...auth, 'idempotency-key': key }, body);
}

export interface World {
  org: Org;
  ng: string;
  gh: string;
  w1: string;
  w2: string;
  shop: string;
  dept: string;
  g1: string;
  m: string;
  yd: string;
  roll: string;
  /** untracked, base unit metre (2dp); roll->m x50 and yd->m x0.9144 conversions */
  fabric: { productId: string; variantId: string };
  /** roll-tracked, base unit yard (2dp) */
  rolled: { productId: string; variantId: string };
  /** lot-tracked, base unit metre */
  lotted: { productId: string; variantId: string };
}

export async function buildWorld(app: FastifyInstance, org: Org): Promise<World> {
  const a = org.auth;
  const le = async (name: string, countryCode: string, cur: string) =>
    (await call(app, 'POST', '/v1/legal-entities', a, { name, countryCode, functionalCurrency: cur })).body.id as string;
  const loc = async (legalEntityId: string, type: string, name: string, countryCode: string) =>
    (await call(app, 'POST', '/v1/locations', a, { legalEntityId, type, name, countryCode, timezone: 'Africa/Lagos' })).body.id as string;
  const ng = await le('NG', 'NG', 'NGN');
  const gh = await le('GH', 'GH', 'GHS');
  const unit = async (code: string, kind: string, precision: number) =>
    (await call(app, 'POST', '/v1/units', a, { code, name: code, kind, precision })).body.id as string;
  const m = await unit('m', 'decimal', 2);
  const yd = await unit('yd', 'decimal', 2);
  const roll = await unit('roll', 'discrete', 0);

  const product = async (name: string, base: string, tracking: string, conversions: unknown[] = []) => {
    const r = await call(app, 'POST', '/v1/products', a, {
      name,
      baseUnitId: base,
      variants: [{ sku: `${name}-${crypto.randomUUID().slice(0, 6)}`, tracking }],
      conversions,
    });
    if (r.status !== 201) throw new Error(JSON.stringify(r.body));
    return { productId: r.body.id as string, variantId: r.body.variantIds[0] as string };
  };
  return {
    org, ng, gh, m, yd, roll,
    w1: await loc(ng, 'warehouse', 'W1', 'NG'),
    w2: await loc(ng, 'warehouse', 'W2', 'NG'),
    shop: await loc(ng, 'branch', 'Shop', 'NG'),
    dept: await loc(ng, 'department', 'Finance', 'NG'),
    g1: await loc(gh, 'warehouse', 'G1', 'GH'),
    fabric: await product('Fabric', m, 'none', [
      { fromUnitId: roll, toUnitId: m, factor: '50' },
      { fromUnitId: yd, toUnitId: m, factor: '0.9144' },
    ]),
    rolled: await product('Rolled', yd, 'roll'),
    lotted: await product('Lotted', m, 'lot'),
  };
}

export async function balance(app: FastifyInstance, auth: Headers, q: { locationId: string; variantId: string; lotId?: string; state?: string }) {
  const params = new URLSearchParams({ locationId: q.locationId, variantId: q.variantId });
  if (q.state) params.set('state', q.state);
  const r = await call(app, 'GET', `/v1/inventory/balances?${params}`, auth);
  const rows = r.body.filter((b: any) => (q.lotId === undefined ? true : b.lotId === q.lotId) && (q.state ? b.state === q.state : b.state === 'on_hand'));
  const row = rows[0] ?? { quantity: '0', reserved: '0', available: '0' };
  return row as { quantity: string; reserved: string; available: string };
}

export async function receive(app: FastifyInstance, auth: Headers, locationId: string, variantId: string, quantity: string, extra: Record<string, unknown> = {}) {
  const r = await cmd(app, auth, '/v1/inventory/receipts', { locationId, lines: [{ variantId, quantity, ...extra }] });
  if (r.status !== 201) throw new Error(`receipt failed: ${JSON.stringify(r.body)}`);
  return r.body as { commandId: string; lines: { lotId: string | null; quantity: string }[] };
}

export async function reconciled(app: FastifyInstance, auth: Headers) {
  const r = await call(app, 'GET', '/v1/inventory/reconciliation', auth);
  return r.body as { consistent: boolean; discrepancies: unknown[] };
}

export { staff };
