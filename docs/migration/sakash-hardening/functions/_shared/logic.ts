// Pure decision logic for the Sakash payment fix. No network, no Deno APIs, so it runs (and is tested) anywhere.
// Money is integer kobo throughout; the app's floating-point naira never decides what is charged.

/** Coupon rates in basis points (1000 = 10%). The server is the only place these apply; later move them to settings. */
export const COUPONS: Record<string, number> = { PF10: 1000, ANKARA20: 2000 };

export interface ProductRecord {
  price: number;                    // naira, as stored in Firestore
  promoDiscountPercent?: number;    // 0 to 100
  stockQuantity?: number;
}
export interface OrderLine { productId: string; qty: number }
export interface Priced {
  lines: { productId: string; qty: number; unitKobo: number; lineKobo: number }[];
  itemsKobo: number;
  couponKobo: number;
  deliveryKobo: number;
  totalKobo: number;
}

const toKobo = (naira: number): number => Math.round(naira * 100);
const roundDiv = (n: number, d: number): number => Math.floor((2 * n + d) / (2 * d));   // half-up for non-negative n

/** Price after the product's own promotion, in kobo, the way the app shows it (price minus promo percent). */
export function unitKobo(p: ProductRecord): number {
  const promo = p.promoDiscountPercent ?? 0;
  if (!(p.price > 0) || !Number.isFinite(p.price)) throw new Error('product has no valid price');
  if (!(promo >= 0 && promo <= 100)) throw new Error('product has an invalid promotion');
  return roundDiv(toKobo(p.price) * (10000 - Math.round(promo * 100)), 10000);
}

export class PricingError extends Error {}

/**
 * The amount the customer must pay, from what the server knows: product prices it read itself, a coupon it recognises,
 * and a delivery fee kept within a ceiling. Anything the client claims about price is ignored.
 */
export function priceOrder(input: {
  lines: OrderLine[];
  products: Map<string, ProductRecord | null>;
  couponCode?: string | null;
  deliveryFeeNaira?: number;
  maxDeliveryFeeNaira: number;
}): Priced {
  if (!input.lines.length || input.lines.length > 100) throw new PricingError('An order needs between 1 and 100 lines');
  const seen = new Set<string>();
  const lines = input.lines.map((l) => {
    if (seen.has(l.productId)) throw new PricingError('A product appears twice; combine the lines');
    seen.add(l.productId);
    if (!Number.isInteger(l.qty) || l.qty < 1 || l.qty > 1000) throw new PricingError('Quantity must be a whole number from 1 to 1000');
    const product = input.products.get(l.productId);
    if (!product) throw new PricingError('A product in the order no longer exists');
    if (product.stockQuantity !== undefined && product.stockQuantity < l.qty) throw new PricingError('Not enough stock for a product in the order');
    const unit = unitKobo(product);
    return { productId: l.productId, qty: l.qty, unitKobo: unit, lineKobo: unit * l.qty };
  });
  const itemsKobo = lines.reduce((a, l) => a + l.lineKobo, 0);

  const code = (input.couponCode ?? '').trim().toUpperCase();
  let couponKobo = 0;
  if (code) {
    const bps = COUPONS[code];
    if (bps === undefined) throw new PricingError('Unknown coupon code');
    couponKobo = roundDiv(itemsKobo * bps, 10000);
  }

  const fee = input.deliveryFeeNaira ?? 0;
  if (!(fee >= 0) || fee > input.maxDeliveryFeeNaira) throw new PricingError('Delivery fee is outside the allowed range');
  const deliveryKobo = toKobo(fee);

  const totalKobo = itemsKobo - couponKobo + deliveryKobo;
  if (totalKobo <= 0) throw new PricingError('Order total must be greater than zero');
  return { lines, itemsKobo, couponKobo, deliveryKobo, totalKobo };
}

/** Paystack signs the exact bytes of the webhook body: hex HMAC-SHA512 with the secret key, in x-paystack-signature. */
export async function verifyPaystackSignature(rawBody: string, signature: string | null, secret: string): Promise<boolean> {
  if (!signature || !secret) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-512' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody)));
  const expected = Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('');
  const given = signature.trim().toLowerCase();
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

export interface Attempt { status: string; reference: string; expectedAmountKobo: number; currency: string; orderId: string; userId: string }
export interface PaystackTx { status: string; reference: string; amount: number; currency: string }
export type Settlement = { ok: true; alreadyDone: boolean } | { ok: false; reason: string };

/** Whether a Paystack transaction really settles the attempt. Every check must pass; there is no partial credit. */
export function settle(attempt: Attempt | null, tx: PaystackTx): Settlement {
  if (!attempt) return { ok: false, reason: 'unknown_reference' };
  if (tx.reference !== attempt.reference) return { ok: false, reason: 'reference_mismatch' };
  if (tx.status !== 'success') return { ok: false, reason: 'not_successful' };
  if (tx.currency !== attempt.currency) return { ok: false, reason: 'currency_mismatch' };
  if (!Number.isInteger(tx.amount) || tx.amount !== attempt.expectedAmountKobo) return { ok: false, reason: 'amount_mismatch' };
  if (attempt.status === 'verified') return { ok: true, alreadyDone: true };
  if (attempt.status !== 'initialized') return { ok: false, reason: `attempt_${attempt.status}` };
  return { ok: true, alreadyDone: false };
}
