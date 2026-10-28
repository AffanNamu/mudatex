'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ProductCard } from '@/components/ProductCard';
import { shopRequest } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useCart } from '@/lib/cart';
import { useI18n } from '@/lib/i18n';
import type { ProductCard as Card } from '@/lib/types';

export default function Wishlist() {
  const { token } = useAuth();
  const { store } = useCart();
  const { t } = useI18n();
  const [items, setItems] = useState<Card[] | null>(null);
  useEffect(() => { if (token) shopRequest<Card[]>('/me/wishlist', { token }).then(setItems).catch(() => setItems([])); }, [token]);
  if (!items) return <p className="muted" role="status">{t('loading')}</p>;
  const shown = items; // an item you un-heart stays until you leave the page, so it can be undone
  if (!shown.length) return <div className="empty"><h2>{t('wishlist.empty')}</h2><p className="muted">{t('wishlist.emptyText')}</p><Link className="btn" href="/shop">{t('wishlist.browse')}</Link></div>;
  return <div className="products">{shown.map((p) => <ProductCard key={p.id} p={p} store={store} />)}</div>;
}
