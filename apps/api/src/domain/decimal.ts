import { QuantityError } from './quantity.js';

/** Fixed-point helpers over BigInt so stock quantities never touch binary floating point. */
export const QTY_SCALE = 6;

const DECIMAL = /^\d+(\.\d+)?$/;

export function toScaled(value: string, scale = QTY_SCALE): bigint {
  if (!DECIMAL.test(value)) throw new QuantityError(`"${value}" is not a non-negative decimal number`);
  const [whole = '0', fraction = ''] = value.split('.');
  if (fraction.length > scale) throw new QuantityError(`At most ${scale} decimal places are supported`);
  return BigInt(whole + fraction.padEnd(scale, '0'));
}

export function fromScaled(n: bigint, scale = QTY_SCALE): string {
  const negative = n < 0n;
  const digits = (negative ? -n : n).toString().padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

/** Canonical form of a numeric string coming from Postgres ("12.500000" -> "12.5"). */
export function normalize(value: string, scale = QTY_SCALE): string {
  const negative = value.startsWith('-');
  return fromScaled((negative ? -1n : 1n) * toScaled(negative ? value.slice(1) : value, scale), scale);
}

export function sum(values: string[]): string {
  return fromScaled(values.reduce((acc, v) => acc + toScaled(v), 0n));
}

/**
 * Exact conversion by an explicit factor into a unit with `targetPrecision` decimals.
 * Results that are not representable are rejected rather than rounded.
 */
export function convertExact(quantity: string, factor: string, targetPrecision: number): string {
  const FACTOR_SCALE = 8;
  const product = toScaled(quantity) * toScaled(factor, FACTOR_SCALE); // scale 6 + 8
  const drop = BigInt(10) ** BigInt(QTY_SCALE + FACTOR_SCALE - targetPrecision);
  if (product % drop !== 0n) {
    throw new QuantityError(`Converted quantity needs more than ${targetPrecision} decimal places`);
  }
  return fromScaled(product / drop, targetPrecision);
}
