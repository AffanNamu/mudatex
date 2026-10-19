export interface UnitSpec {
  code: string;
  kind: 'discrete' | 'decimal';
  precision: number;
}

/**
 * Validates a quantity string against a unit. Quantities stay strings so no
 * binary floating point touches stock or money. Over-precise input is rejected,
 * never silently rounded.
 */
export function parseQuantity(value: string, unit: UnitSpec): string {
  if (!/^\d+(\.\d+)?$/.test(value)) {
    throw new QuantityError(`"${value}" is not a non-negative decimal number`);
  }
  const [, fraction = ''] = value.split('.');
  if (fraction.length > unit.precision) {
    throw new QuantityError(`${unit.code} allows at most ${unit.precision} decimal places`);
  }
  if (unit.kind === 'discrete' && fraction.length > 0) {
    throw new QuantityError(`${unit.code} is a discrete unit and requires a whole number`);
  }
  return value;
}

export class QuantityError extends Error {}
