export interface Department { slug: string; name: string; imageUrl: string | null; productCount: number }

export interface ProductCard {
  id: string; slug: string; title: string; brand: string | null; images: string[]; badges: string[];
  department: { slug: string; name: string } | null; priceMinor: number; currency: string; inStock: boolean;
}

export interface Store {
  slug: string; name: string; tagline: string | null; currency: string; minorUnit: number; cardPayments: boolean;
  contact: { whatsapp?: string; phone?: string; email?: string; address?: string; bankName?: string; accountName?: string; accountNumber?: string };
  departments: Department[]; featured: ProductCard[];
}

export interface Variant {
  variantId: string; sku: string; attributes: Record<string, string>; unitPrice: string; priceMinor: number;
  taxInclusive: boolean; available: number; inStock: boolean;
}

export interface ProductDetail {
  id: string; slug: string; title: string; description: string | null; brand: string | null; images: string[]; badges: string[];
  rating: { average: number | null; count: number };
  department: { slug: string; name: string } | null; category: string | null; attributes: Record<string, unknown>;
  unit: { code: string; name: string; kind: 'discrete' | 'decimal'; precision: number };
  conversions: { fromCode: string; fromName: string; toCode: string; factor: string }[];
  currency: string; variants: Variant[];
}

export interface Page<T> { page: number; limit: number; total: number; items: T[] }

export interface Customer { id: string; email: string; fullName: string; phone: string | null; marketingOptIn: boolean }

export interface Address {
  id: string; label: string; recipient: string; phone: string; line1: string; line2: string | null; city: string; state: string;
  countryCode: string; isDefault: boolean;
}

export interface BasketQuote {
  currency: string;
  lines: { variantId: string; sku: string; title: string; quantity: string; unitPrice: string; totalMinor: number; inStock: boolean; available: number }[];
  subtotalMinor: number; taxMinor: number; discountMinor: number; coupon: { code: string; percentBps: number } | null; deliveryFeeMinor: number | null; totalMinor: number | null; allInStock: boolean;
  delivery: { zone: string; feeMinor: number; freeOverMinor: number | null; etaDays: { min: number; max: number } } | null;
  trade: { creditAvailableMinor: number } | null;
}

export interface Order {
  id: string; orderNo: string; status: string; currency: string; discountMinor: number; couponCode: string | null; subtotalMinor: number; deliveryFeeMinor: number; totalMinor: number; paidMinor: number;
  paymentMethod: string; dueOn: string | null; carrier: string | null; trackingRef: string | null; expiresAt: string; placedAt: string;
  delivery: { recipient: string; line1: string; line2: string | null; city: string; state: string; zone: string; etaDays: { min: number; max: number } };
  lines: { lineNo: number; variantId: string; productSlug: string | null; image: string | null; unit: string; title: string; sku: string; quantity: string; unitPrice: string; totalMinor: number }[];
  events: { status: string; at: string; note: string | null }[];
}

export interface Review { rating: number; title: string | null; body: string; name: string; at: string }

export interface TradeAccount {
  id: string; businessName: string; taxId: string | null; status: 'pending' | 'approved' | 'rejected' | 'suspended'; creditLimitMinor: number;
  paymentTermsDays: number; note: string | null; creditUsedMinor?: number; creditAvailableMinor?: number;
  statement?: { at: string; kind: 'order' | 'payment'; reference: string; amountMinor: number; balanceMinor: number }[];
}
