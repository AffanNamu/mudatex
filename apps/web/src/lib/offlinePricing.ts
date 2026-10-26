/**
 * Prices a sale on the till without the server, for offline selling only. It follows the server's rules exactly
 * (round half up at each step; tax after discount; inclusive tax is the part contained in the price) and the server
 * prices every offline sale again when it arrives, recording any difference. The online till never uses this.
 */
const QTY_SCALE = 6;
const PRICE_SCALE = 4;
const RATE_SCALE = 6;
const pow10 = (n: number) => 10n ** BigInt(n);

function scaled(value: string, scale: number): bigint {
  const [w = '0', f = ''] = value.trim().split('.');
  return BigInt(w) * pow10(scale) + BigInt(f.padEnd(scale, '0').slice(0, scale));
}
const roundDiv = (n: bigint, d: bigint) => (n * 2n + d) / (d * 2n);

export interface PricedLine { gross: number; discount: number; tax: number; total: number }

export function priceLineLocal(a: { quantity: string; unitPrice: string; minorUnit: number; discountBps: number; taxRate: string | null; taxInclusive: boolean }): PricedLine {
  const exact = scaled(a.quantity, QTY_SCALE) * scaled(a.unitPrice, PRICE_SCALE);
  const gross = roundDiv(exact * pow10(a.minorUnit), pow10(QTY_SCALE + PRICE_SCALE));
  const discount = a.discountBps > 0 ? roundDiv(gross * BigInt(a.discountBps), 10000n) : 0n;
  const net = gross - discount;
  let tax = 0n;
  let total = net;
  if (a.taxRate && scaled(a.taxRate, RATE_SCALE) > 0n) {
    const rate = scaled(a.taxRate, RATE_SCALE);
    if (a.taxInclusive) tax = roundDiv(net * rate, pow10(RATE_SCALE) + rate);
    else { tax = roundDiv(net * rate, pow10(RATE_SCALE)); total = net + tax; }
  }
  return { gross: Number(gross), discount: Number(discount), tax: Number(tax), total: Number(total) };
}

export function sumLines(lines: PricedLine[]) {
  const sum = (f: (l: PricedLine) => number) => lines.reduce((a, l) => a + f(l), 0);
  return { subtotal: sum((l) => l.gross), discount: sum((l) => l.discount), tax: sum((l) => l.tax), total: sum((l) => l.total) };
}
