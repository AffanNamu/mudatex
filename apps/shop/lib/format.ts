export function formatMoney(minor: number, currency: string, minorUnit: number): string {
  const major = minor / 10 ** minorUnit;
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency, currencyDisplay: 'narrowSymbol', minimumFractionDigits: minorUnit, maximumFractionDigits: minorUnit }).format(major);
  } catch {
    return `${currency} ${major.toFixed(minorUnit)}`;
  }
}

/** Trailing zeros removed: "2.50" -> "2.5". Quantities are decimal strings and stay strings. */
export const trimQty = (q: string) => (q.includes('.') ? q.replace(/0+$/, '').replace(/\.$/, '') : q);

export const whatsappLink = (number: string | undefined, text: string) =>
  number ? `https://wa.me/${number.replace(/\D/g, '')}?text=${encodeURIComponent(text)}` : null;
