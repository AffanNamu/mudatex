import type { FastifyInstance } from 'fastify';
import { call, staff } from './helpers.js';
import { buildWorld, cmd, receive, type World } from './inventory-helpers.js';

export interface PosWorld extends World {
  vat: string;          // 7.5% exclusive
  vatIncl: string;      // 7.5% inclusive
  priceList: string;
  inclusive: { productId: string; variantId: string };
  reg1: string;
  reg2: string;
  cashier: Awaited<ReturnType<typeof staff>>;
  supervisor: Awaited<ReturnType<typeof staff>>;
}

export const CASHIER_PERMS = ['pos.sell', 'pos.session', 'pos.discount', 'pos.refund', 'pos.read', 'inventory.read'];
export const SUPERVISOR_PERMS = [
  'pos.sell', 'pos.session', 'pos.discount', 'pos.discount.override', 'pos.refund', 'pos.refund.approve',
  'pos.payment.verify', 'pos.read', 'inventory.read',
];

export async function buildPosWorld(app: FastifyInstance, base: World, stock = '100'): Promise<PosWorld> {
  const a = base.org.auth;
  const tax = async (code: string, rate: string, priceInclusive: boolean) => {
    const r = await call(app, 'POST', '/v1/pricing/tax-codes', a, { legalEntityId: base.ng, code, name: code, rate, priceInclusive });
    if (r.status !== 201) throw new Error(JSON.stringify(r.body));
    return r.body.id as string;
  };
  const vat = await tax('VAT75', '0.075', false);
  const vatIncl = await tax('VATI75', '0.075', true);
  const pl = await call(app, 'POST', '/v1/pricing/price-lists', a, { legalEntityId: base.ng, name: 'Retail NGN', currency: 'NGN' });
  const priceList = pl.body.id as string;

  const inc = await call(app, 'POST', '/v1/products', a, { name: 'Inclusive', baseUnitId: base.m, variants: [{ sku: `INC-${crypto.randomUUID().slice(0, 6)}` }] });
  const inclusive = { productId: inc.body.id as string, variantId: inc.body.variantIds[0] as string };

  const price = async (variantId: string, unitPrice: string, taxCodeId: string | null) => {
    const r = await call(app, 'PUT', `/v1/pricing/price-lists/${priceList}/items`, a, { variantId, unitPrice, taxCodeId });
    if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  };
  await price(base.fabric.variantId, '3500.50', vat);
  await price(base.rolled.variantId, '1200', null);
  await price(base.lotted.variantId, '800', vat);
  await price(inclusive.variantId, '33.34', vatIncl);

  const register = async (code: string) => {
    const r = await call(app, 'POST', '/v1/pos/registers', a, { locationId: base.shop, code, name: code, priceListId: priceList, maxDiscountBps: 1000, refundThresholdMinor: 100000 });
    if (r.status !== 201) throw new Error(JSON.stringify(r.body));
    return r.body.id as string;
  };
  const reg1 = await register('SHOP1');
  const reg2 = await register('SHOP2');

  await receive(app, a, base.shop, base.fabric.variantId, stock);
  await receive(app, a, base.shop, inclusive.variantId, stock);
  const cashier = await staff(app, a, CASHIER_PERMS, { type: 'location', id: base.shop });
  const supervisor = await staff(app, a, SUPERVISOR_PERMS, { type: 'location', id: base.shop });
  return { ...base, vat, vatIncl, priceList, inclusive, reg1, reg2, cashier, supervisor };
}

export async function openSession(app: FastifyInstance, auth: any, registerId: string, openingFloatMinor = 0) {
  const r = await cmd(app, auth, `/v1/pos/registers/${registerId}/sessions`, { openingFloatMinor });
  if (r.status !== 201) throw new Error(`open session failed: ${JSON.stringify(r.body)}`);
  return r.body.id as string;
}

type Method = 'cash' | 'card' | 'bank_transfer' | 'mobile_money';

export function saleBody(registerId: string, lines: unknown[], payments: unknown[], extra: Record<string, unknown> = {}) {
  return { registerId, lines, payments, ...extra };
}

export async function sell(app: FastifyInstance, auth: any, registerId: string, lines: unknown[], payments: unknown[], extra: Record<string, unknown> = {}, key?: string) {
  return cmd(app, auth, '/v1/pos/sales', saleBody(registerId, lines, payments, extra), key);
}

export const cash = (amountMinor: number, tenderedMinor?: number) => ({ method: 'cash' as Method, amountMinor, ...(tenderedMinor ? { tenderedMinor } : {}) });
export const card = (amountMinor: number, reference = `CARD-${crypto.randomUUID().slice(0, 8)}`) => ({ method: 'card' as Method, amountMinor, reference });
