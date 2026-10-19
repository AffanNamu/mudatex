import { toScaled } from './decimal.js';
import { QuantityError } from './quantity.js';

/**
 * Money is integer minor units. Rounding policy (pending finance approval, ADR 012):
 * every line is rounded half-up to minor units after each step, and sale totals are the
 * sum of rounded lines, so a receipt always adds up.
 */
export const RATE_SCALE = 6;
const PRICE_SCALE = 4;
const QTY_SCALE = 6;

export class MoneyError extends Error {}

/** Round-half-up division for a non-negative numerator and a positive denominator. */
export function roundDiv(numerator: bigint, denominator: bigint): bigint {
  if (numerator < 0n || denominator <= 0n) throw new MoneyError('roundDiv expects n >= 0 and d > 0');
  return (numerator * 2n + denominator) / (denominator * 2n);
}

const pow10 = (n: number) => 10n ** BigInt(n);

/** quantity (base unit, <= 6 dp) x unit price (<= 4 dp) rounded to minor units. */
export function grossMinor(quantity: string, unitPrice: string, minorUnit: number): bigint {
  const exact = toScaled(quantity, QTY_SCALE) * toScaled(unitPrice, PRICE_SCALE); // scale 10, major units
  return roundDiv(exact * pow10(minorUnit), pow10(QTY_SCALE + PRICE_SCALE));
}

export type DiscountInput = { type: 'percent'; basisPoints: number } | { type: 'amount'; amountMinor: number };

export interface TaxInput {
  code: string;
  rate: string; // decimal fraction, e.g. "0.075"
  inclusive: boolean;
}

export interface PricedLine {
  gross: bigint;
  discount: bigint;
  discountBps: number | null;
  net: bigint;
  tax: bigint;
  total: bigint;
}

export function priceLine(args: {
  quantity: string;
  unitPrice: string;
  minorUnit: number;
  discount?: DiscountInput;
  tax?: TaxInput | null;
}): PricedLine {
  const gross = grossMinor(args.quantity, args.unitPrice, args.minorUnit);
  let discount = 0n;
  let discountBps: number | null = null;
  if (args.discount?.type === 'percent') {
    discountBps = args.discount.basisPoints;
    discount = roundDiv(gross * BigInt(discountBps), 10000n);
  } else if (args.discount?.type === 'amount') {
    discount = BigInt(args.discount.amountMinor);
    if (discount > gross) throw new MoneyError('Discount exceeds the line amount');
  }
  const net = gross - discount;

  let tax = 0n;
  let total = net;
  if (args.tax) {
    const rate = toScaled(args.tax.rate, RATE_SCALE);
    if (args.tax.inclusive) {
      tax = roundDiv(net * rate, pow10(RATE_SCALE) + rate); // tax contained in the net price
    } else {
      tax = roundDiv(net * rate, pow10(RATE_SCALE));
      total = net + tax;
    }
  }
  return { gross, discount, discountBps, net, tax, total };
}

/**
 * Refund share for returning `returnedAfter` of `quantity` units when `returnedBefore` were already
 * returned. Uses cumulative rounding so the shares of all partial returns sum exactly to the line amount.
 */
export function refundShare(lineAmount: bigint, quantity: string, returnedBefore: string, returnedAfter: string): bigint {
  const q = toScaled(quantity, QTY_SCALE);
  if (q <= 0n) throw new QuantityError('Line quantity must be positive');
  const cumulative = (r: bigint) => roundDiv(lineAmount * r, q);
  return cumulative(toScaled(returnedAfter, QTY_SCALE)) - cumulative(toScaled(returnedBefore, QTY_SCALE));
}
