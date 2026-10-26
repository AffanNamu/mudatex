'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { shopRequest } from './api';
import { useAuth } from './auth';
import type { ProductCard } from './types';

interface WishlistValue {
  slugs: Set<string>;
  toggle(slug: string): Promise<'needs-login' | 'ok'>;
}

const Ctx = createContext<WishlistValue | null>(null);

export function WishlistProvider({ children }: { children: ReactNode }) {
  const { token, profile } = useAuth();
  const [slugs, setSlugs] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!token || profile !== 'ready') { setSlugs(new Set()); return; }
    let cancelled = false;
    shopRequest<ProductCard[]>('/me/wishlist', { token })
      .then((items) => { if (!cancelled) setSlugs(new Set(items.map((i) => i.slug))); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [token, profile]);

  const toggle = useCallback(async (slug: string) => {
    if (!token || profile !== 'ready') return 'needs-login' as const;
    const has = slugs.has(slug);
    setSlugs((cur) => { const next = new Set(cur); if (has) next.delete(slug); else next.add(slug); return next; });
    try {
      await shopRequest(`/me/wishlist/${encodeURIComponent(slug)}`, { method: has ? 'DELETE' : 'PUT', token });
    } catch {
      setSlugs((cur) => { const next = new Set(cur); if (has) next.add(slug); else next.delete(slug); return next; });
    }
    return 'ok' as const;
  }, [token, profile, slugs]);

  const value = useMemo(() => ({ slugs, toggle }), [slugs, toggle]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWishlist(): WishlistValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useWishlist outside WishlistProvider');
  return v;
}
