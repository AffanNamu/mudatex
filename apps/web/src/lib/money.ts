/** Money is integer minor units end to end; text is parsed and formatted without floating point. */

export function formatMoney(minor: number, currency: string, minorUnit: number): string {
  const negative = minor < 0;
  const digits = String(Math.abs(minor)).padStart(minorUnit + 1, '0');
  const whole = digits.slice(0, digits.length - minorUnit);
  const frac = minorUnit ? digits.slice(digits.length - minorUnit) : '';
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${currencySymbol(currency)}${grouped}${frac ? `.${frac}` : ''}`;
}

const SYMBOLS: Record<string, string> = { NGN: '₦', USD: '$', EUR: '€', GBP: '£', GHS: 'GH₵', KES: 'KSh ', ZAR: 'R', XOF: 'CFA ', UGX: 'USh ' };
export const currencySymbol = (c: string) => SYMBOLS[c] ?? `${c} `;

/**
 * Parses what a person typed ("1,234.5") into minor units. Returns null for anything ambiguous or over-precise
 * rather than rounding it: a till must never silently change an amount.
 */
export function parseMoney(text: string, minorUnit: number): number | null {
  const t = text.trim().replace(/,/g, '');
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const [whole = '0', frac = ''] = t.split('.');
  if (frac.length > minorUnit) return null;
  const minor = Number(whole + frac.padEnd(minorUnit, '0'));
  return Number.isSafeInteger(minor) ? minor : null;
}

/** A positive decimal quantity as typed, or null. Kept as a string: the server owns quantity arithmetic. */
export function parseQuantity(text: string): string | null {
  const t = text.trim();
  return /^\d+(\.\d+)?$/.test(t) && Number(t) > 0 ? t : null;
}

/** Basis points from a typed percentage such as "12.5" (= 1250). Null when it is not a valid 0–100 value with ≤2 decimals. */
export function percentToBps(text: string): number | null {
  const t = text.trim();
  if (t === '') return 0;
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const [w = '0', f = ''] = t.split('.');
  const bps = Number(w) * 100 + Number(f.padEnd(2, '0'));
  return bps <= 10000 ? bps : null;
}

