import { describe, expect, it } from 'vitest';
import { decodeFields, encodeFields } from './functions/_shared/firestore.js';
import { PricingError, priceOrder, settle, unitKobo, verifyPaystackSignature, type Attempt, type ProductRecord } from './functions/_shared/logic.js';

const products = (o: Record<string, ProductRecord | null>) => new Map(Object.entries(o));
const attempt = (o: Partial<Attempt> = {}): Attempt => ({ status: 'initialized', reference: 'SAK_1', expectedAmountKobo: 1_000_000, currency: 'NGN', orderId: 'o1', userId: 'u1', ...o });
const tx = (o = {}) => ({ status: 'success', reference: 'SAK_1', amount: 1_000_000, currency: 'NGN', ...o });

describe('priceOrder', () => {
  const base = { maxDeliveryFeeNaira: 50_000 };
  it('prices from server data, applies promotions, coupon and delivery in whole kobo', () => {
    const r = priceOrder({ ...base, lines: [{ productId: 'a', qty: 2 }, { productId: 'b', qty: 1 }], products: products({ a: { price: 5000, promoDiscountPercent: 10 }, b: { price: 1999.99 } }), couponCode: 'pf10', deliveryFeeNaira: 1500 });
    expect(r.itemsKobo).toBe(2 * 450_000 + 199_999);          // 1,099,999
    expect(r.couponKobo).toBe(110_000);                        // 10% of 1,099,999 = 109,999.9, half-up
    expect(r.deliveryKobo).toBe(150_000);
    expect(r.totalKobo).toBe(1_099_999 - 110_000 + 150_000);
  });
  it('rejects what a tampered client could send', () => {
    const p = products({ a: { price: 100 } });
    const bad = (x: Partial<Parameters<typeof priceOrder>[0]>) => () => priceOrder({ ...base, lines: [{ productId: 'a', qty: 1 }], products: p, ...x });
    expect(bad({ lines: [] })).toThrow(PricingError);
    expect(bad({ lines: [{ productId: 'a', qty: 0 }] })).toThrow(/Quantity/);
    expect(bad({ lines: [{ productId: 'a', qty: 1.5 }] })).toThrow(/Quantity/);
    expect(bad({ lines: [{ productId: 'a', qty: 1 }, { productId: 'a', qty: 1 }] })).toThrow(/twice/);
    expect(bad({ lines: [{ productId: 'zzz', qty: 1 }] })).toThrow(/no longer exists/);
    expect(bad({ couponCode: 'FREE100' })).toThrow(/Unknown coupon/);
    expect(bad({ deliveryFeeNaira: -5 })).toThrow(/Delivery fee/);
    expect(bad({ deliveryFeeNaira: 1e9 })).toThrow(/Delivery fee/);
    expect(bad({ products: products({ a: { price: 100, stockQuantity: 0 } }) })).toThrow(/stock/);
    expect(bad({ products: products({ a: { price: 0 } }) })).toThrow(/valid price/);
    expect(bad({ products: products({ a: { price: 100, promoDiscountPercent: 150 } }) })).toThrow(/promotion/);
  });
  it('rounds a promotion half-up to the kobo', () => { expect(unitKobo({ price: 0.15, promoDiscountPercent: 50 })).toBe(8); });
});

describe('verifyPaystackSignature', () => {
  const sign = async (body: string, secret: string) => {
    const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-512' }, false, ['sign']);
    return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(body))), (b) => b.toString(16).padStart(2, '0')).join('');
  };
  it('accepts only the exact body signed with the secret', async () => {
    const body = '{"event":"charge.success","data":{"reference":"SAK_1"}}';
    const good = await sign(body, 'sk_test_secret');
    expect(await verifyPaystackSignature(body, good, 'sk_test_secret')).toBe(true);
    expect(await verifyPaystackSignature(body, good.toUpperCase(), 'sk_test_secret')).toBe(true);
    expect(await verifyPaystackSignature(body + ' ', good, 'sk_test_secret')).toBe(false);
    expect(await verifyPaystackSignature(body, good, 'other_secret')).toBe(false);
    expect(await verifyPaystackSignature(body, good.slice(0, -2), 'sk_test_secret')).toBe(false);
    expect(await verifyPaystackSignature(body, null, 'sk_test_secret')).toBe(false);
    expect(await verifyPaystackSignature(body, good, '')).toBe(false);
  });
});

describe('settle', () => {
  it('accepts a matching successful payment once, and recognises a replay', () => {
    expect(settle(attempt(), tx())).toEqual({ ok: true, alreadyDone: false });
    expect(settle(attempt({ status: 'verified' }), tx())).toEqual({ ok: true, alreadyDone: true });
  });
  it('refuses every way the money does not match', () => {
    expect(settle(null, tx())).toEqual({ ok: false, reason: 'unknown_reference' });
    expect(settle(attempt(), tx({ reference: 'SAK_2' }))).toEqual({ ok: false, reason: 'reference_mismatch' });
    expect(settle(attempt(), tx({ status: 'abandoned' }))).toEqual({ ok: false, reason: 'not_successful' });
    expect(settle(attempt(), tx({ amount: 100 }))).toEqual({ ok: false, reason: 'amount_mismatch' });      // the "pay ₦1 for a ₦10,000 order" attack
    expect(settle(attempt(), tx({ amount: 1_000_000.5 }))).toEqual({ ok: false, reason: 'amount_mismatch' });
    expect(settle(attempt(), tx({ currency: 'USD' }))).toEqual({ ok: false, reason: 'currency_mismatch' });
    expect(settle(attempt({ status: 'rejected' }), tx())).toEqual({ ok: false, reason: 'attempt_rejected' });
  });
});

describe('Firestore encoding', () => {
  it('round-trips the shapes the functions write and read', () => {
    const doc = { reference: 'SAK_1', amount: 100.5, count: 3, ok: true, nothing: null, items: [{ productId: 'a', qty: 2 }], verification: { source: 'x' } };
    expect(decodeFields(encodeFields(doc))).toEqual(doc);
    expect(encodeFields({ n: 3 }).n).toEqual({ integerValue: '3' });
    expect(encodeFields({ n: 3.5 }).n).toEqual({ doubleValue: 3.5 });
  });
});
