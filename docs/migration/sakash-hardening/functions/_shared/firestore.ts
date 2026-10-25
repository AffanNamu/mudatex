// Firestore REST value encoding, pure and testable. The functions talk to Firestore with a service account, so they
// bypass security rules; this is why the rules can forbid clients from writing payment data at all.

export type FsValue = Record<string, unknown>;
export type FsFields = Record<string, FsValue>;

export function decodeValue(v: FsValue): unknown {
  if ('nullValue' in v) return null;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('stringValue' in v) return v.stringValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return ((v.arrayValue as { values?: FsValue[] }).values ?? []).map(decodeValue);
  if ('mapValue' in v) return decodeFields((v.mapValue as { fields?: FsFields }).fields ?? {});
  return undefined;
}
export function decodeFields(fields: FsFields): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, decodeValue(v)]));
}

export function encodeValue(x: unknown): FsValue {
  if (x === null || x === undefined) return { nullValue: null };
  if (typeof x === 'boolean') return { booleanValue: x };
  if (typeof x === 'number') return Number.isInteger(x) ? { integerValue: String(x) } : { doubleValue: x };
  if (typeof x === 'string') return { stringValue: x };
  if (Array.isArray(x)) return { arrayValue: { values: x.map(encodeValue) } };
  if (typeof x === 'object') return { mapValue: { fields: encodeFields(x as Record<string, unknown>) } };
  throw new Error(`cannot encode ${typeof x}`);
}
export function encodeFields(o: Record<string, unknown>): FsFields {
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, encodeValue(v)]));
}
