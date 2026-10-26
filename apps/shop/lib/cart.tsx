'use client';

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Store } from './types';

export interface CartLine {
  variantId: string;
  productSlug: string;
  title: string;
  sku: string;
  image: string | null;
  unit: string;       // base unit code, for display
  quantity: string;   // decimal string in the base unit
  priceMinor: number; // last price shown to the shopper; the server re-prices every time
}

interface CartValue {
  lines: CartLine[];
  count: number;
  add(line: CartLine): void;
  setQuantity(variantId: string, quantity: string): void;
  remove(variantId: string): void;
  clear(): void;
  store: Store;
}

const KEY = 'mudatex.cart.v1';
const Ctx = createContext<CartValue | null>(null);

export const addQty = (a: string, b: string, precision = 6): string => {
  const scale = 10 ** precision;
  return String(Math.round((Number(a) + Number(b)) * scale) / scale);
};

export function CartProvider({ store, children }: { store: Store; children: ReactNode }) {
  const [lines, setLines] = useState<CartLine[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) setLines(JSON.parse(raw) as CartLine[]);
    } catch { /* ignore */ }
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (!loaded) return;
    try { localStorage.setItem(KEY, JSON.stringify(lines)); } catch { /* ignore */ }
  }, [lines, loaded]);

  // Changes made in another tab show up here.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== KEY) return;
      try { setLines(e.newValue ? (JSON.parse(e.newValue) as CartLine[]) : []); } catch { /* ignore */ }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const value = useMemo<CartValue>(() => ({
    lines,
    count: lines.length,
    store,
    add: (line) => setLines((cur) => {
      const found = cur.find((l) => l.variantId === line.variantId);
      if (!found) return [...cur, line];
      return cur.map((l) => (l.variantId === line.variantId ? { ...l, quantity: addQty(l.quantity, line.quantity), priceMinor: line.priceMinor } : l));
    }),
    setQuantity: (variantId, quantity) => setLines((cur) => cur.map((l) => (l.variantId === variantId ? { ...l, quantity } : l))),
    remove: (variantId) => setLines((cur) => cur.filter((l) => l.variantId !== variantId)),
    clear: () => setLines([]),
  }), [lines, store]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCart(): CartValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useCart outside CartProvider');
  return v;
}
