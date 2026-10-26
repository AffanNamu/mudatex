import { API_URL, SHOP_SLUG } from './config';
import type { Page, ProductCard, ProductDetail, Store } from './types';

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) {
    super(message);
  }
}

async function parse<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body.error ?? 'error', body.message ?? 'Something went wrong', body.details);
  return body as T;
}

const shopPath = (p: string) => `${API_URL}/shop/${SHOP_SLUG}${p}`;

/** Server-side reads of the public catalogue, cached briefly. A store that is not live yields null. */
async function publicGet<T>(path: string, revalidate = 60): Promise<T | null> {
  try {
    const res = await fetch(shopPath(path), { next: { revalidate } });
    if (res.status === 404) return null;
    return await parse<T>(res);
  } catch (err) {
    if (err instanceof ApiError) throw err;
    return null; // API unreachable at build or request time: render the "unavailable" state rather than crash
  }
}

export const getStore = () => publicGet<Store>('');
export const getProduct = (slug: string) => publicGet<ProductDetail>(`/products/${encodeURIComponent(slug)}`);
export const getProducts = (qs: URLSearchParams) => publicGet<Page<ProductCard>>(`/products?${qs}`, 30);

/** Browser calls: public (no token) or shopper (bearer token). */
export async function shopRequest<T>(path: string, init: { method?: string; body?: unknown; token?: string; key?: string } = {}): Promise<T> {
  const res = await fetch(shopPath(path), {
    method: init.method ?? (init.body ? 'POST' : 'GET'),
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      ...(init.key ? { 'idempotency-key': init.key } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  return parse<T>(res);
}
