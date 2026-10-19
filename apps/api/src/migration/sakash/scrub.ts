/**
 * Deny-by-default filtering of Sakash documents. Only fields listed here ever leave the source: anything else,
 * including customer names, phone numbers, addresses, emails, user ids and device tokens, is dropped.
 */

type Json = Record<string, unknown>;

export const ARCHIVED_COLLECTIONS = ['orders', 'pos_sales', 'pos_receipts', 'payments'] as const;
export type ArchivedCollection = (typeof ARCHIVED_COLLECTIONS)[number];

/** Collections that are read but not archived: they feed the live catalogue. */
export const MASTER_COLLECTIONS = ['products', 'categories'] as const;

/** Collections deliberately not migrated, with the reason shown in the report. */
export const EXCLUDED_COLLECTIONS: Record<string, string> = {
  users: 'Customer accounts and addresses are personal data; Mudatex has no customer module yet.',
  admins: 'Staff identities belong to the old Firebase project and cannot be mapped to a new identity provider.',
  rides: 'Legacy delivery records, superseded by order tracking.',
  payment_attempts: 'Transient payment initialisation state, not a record of money moved.',
  app_settings: 'Runtime configuration of the old app.',
  pos_analytics: 'Derived figures; Mudatex recomputes reports from source documents.',
  admin_performance: 'Derived figures; Mudatex recomputes reports from source documents.',
};

const ITEM_FIELDS = ['productId', 'id', 'name', 'quantity', 'qty', 'price', 'unitPrice', 'lineTotal', 'total', 'subtotal', 'category', 'color', 'size'];

const ALLOW: Record<ArchivedCollection, { fields: string[]; amountField: string; dateField: string }> = {
  orders: {
    fields: ['id', 'status', 'createdAt', 'totalAmount', 'items', 'paymentReference', 'paymentStatus', 'deliveryFee', 'couponDiscount', 'couponCode', 'trackingNumber'],
    amountField: 'totalAmount', dateField: 'createdAt',
  },
  pos_sales: {
    fields: ['id', 'receiptId', 'branchId', 'branchName', 'status', 'createdAt', 'items', 'subtotal', 'discountValue', 'discountType', 'discountReason', 'finalTotal',
      'paymentMethod', 'mixedPayment', 'amountTendered', 'changeGiven', 'saleChannel'],
    amountField: 'finalTotal', dateField: 'createdAt',
  },
  pos_receipts: {
    fields: ['id', 'receiptId', 'saleId', 'createdAt', 'items', 'subtotal', 'discountValue', 'finalTotal', 'total', 'paymentMethod'],
    amountField: 'finalTotal', dateField: 'createdAt',
  },
  payments: {
    fields: ['id', 'reference', 'paymentReference', 'amount', 'status', 'createdAt', 'currency'],
    amountField: 'amount', dateField: 'createdAt',
  },
};

const pick = (src: Json, keys: string[]): Json => Object.fromEntries(keys.filter((k) => src[k] !== undefined).map((k) => [k, src[k]]));

/** Firestore timestamps arrive as ISO strings, epoch numbers, or {_seconds}/{seconds} objects; normalise to ISO. */
export function normalizeTimestamp(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'string') { const d = new Date(v); return Number.isNaN(+d) ? null : d.toISOString(); }
  if (typeof v === 'number') { const d = new Date(v < 1e12 ? v * 1000 : v); return Number.isNaN(+d) ? null : d.toISOString(); }
  if (typeof v === 'object') {
    const o = v as Json;
    const s = o._seconds ?? o.seconds;
    if (typeof s === 'number') return new Date(s * 1000).toISOString();
  }
  return null;
}

/** A number, or a numeric string, as a finite number; otherwise null. */
export function toNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

export interface Scrubbed {
  payload: Json;
  amount: number | null;
  sourceCreatedAt: string | null;
  droppedFields: string[];
}

export function scrubDocument(collection: ArchivedCollection, raw: Json): Scrubbed {
  const rule = ALLOW[collection];
  const payload = pick(raw, rule.fields);
  if (Array.isArray(payload.items)) {
    payload.items = (payload.items as unknown[]).map((it) => (it && typeof it === 'object' ? pick(it as Json, ITEM_FIELDS) : it));
  }
  if (payload.mixedPayment && typeof payload.mixedPayment === 'object') {
    payload.mixedPayment = pick(payload.mixedPayment as Json, ['cashAmount', 'transferAmount', 'posAmount', 'total']);
  }
  if ('createdAt' in payload) payload.createdAt = normalizeTimestamp(payload.createdAt);
  const dropped = Object.keys(raw).filter((k) => !rule.fields.includes(k) && k !== 'id');
  return { payload, amount: toNumber(raw[rule.amountField]), sourceCreatedAt: normalizeTimestamp(raw[rule.dateField]), droppedFields: dropped };
}
