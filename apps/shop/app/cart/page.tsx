'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { shopRequest } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useCart } from '@/lib/cart';
import { formatMoney, trimQty } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import type { BasketQuote } from '@/lib/types';

export default function CartPage() {
  const { lines, setQuantity, remove, store, coupon, setCoupon } = useCart();
  const { token } = useAuth();
  const { t, c } = useI18n();
  const [typed, setTyped] = useState('');
  const [quote, setQuote] = useState<BasketQuote | null>(null);
  const [problem, setProblem] = useState('');
  const key = JSON.stringify(lines.map((l) => [l.variantId, l.quantity]));
  const money = (m: number) => formatMoney(m, store.currency, store.minorUnit);

  useEffect(() => {
    if (!lines.length) { setQuote(null); setProblem(''); return; }
    let cancelled = false;
    const t = setTimeout(() => {
      shopRequest<BasketQuote>('/basket', { body: { lines: lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity })), ...(coupon ? { couponCode: coupon } : {}) }, ...(token ? { token } : {}) })
        .then((q) => { if (!cancelled) { setQuote(q); setProblem(''); } })
        .catch((err: Error) => {
          if (cancelled) return;
          setQuote(null); setProblem(err.message);
          if (coupon && /coupon/i.test(err.message)) setCoupon(''); // a coupon that no longer works is dropped so the basket can load
        });
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, coupon, token]);

  if (!lines.length) {
    return <div className="wrap empty"><h1>{t('cart.emptyTitle')}</h1><p className="muted">{t('cart.emptyText')}</p><Link className="btn" href="/shop">{t('cart.startShopping')}</Link></div>;
  }
  const byId = new Map(quote?.lines.map((l) => [l.variantId, l]));
  const stuck = !quote || !quote.allInStock;

  return (
    <div className="wrap section">
      <h1>{t('cart.title')}</h1>
      <div className="cartgrid">
        <div>
          {lines.map((l) => {
            const q = byId.get(l.variantId);
            return (
              <div className="line" key={l.variantId}>
                <div className="thumb">{l.image ? <img src={l.image} alt="" /> : <div className="placeholder" aria-hidden="true">{c(l, 'title', l.title).slice(0, 1)}</div>}</div>
                <div>
                  <Link href={`/product/${l.productSlug}`}><strong>{c(l, 'title', l.title)}</strong></Link>
                  <div className="small muted">{l.sku}</div>
                  <div className="row" style={{ marginTop: 8 }}>
                    <label className="small" htmlFor={`q-${l.variantId}`} style={{ margin: 0 }}>{t('cart.qty', { unit: l.unit })}</label>
                    <input id={`q-${l.variantId}`} style={{ width: 90, minHeight: 36 }} inputMode="decimal" value={l.quantity}
                      onChange={(e) => setQuantity(l.variantId, e.target.value)} onBlur={(e) => { const v = trimQty(e.target.value); if (!(Number(v) > 0)) remove(l.variantId); else setQuantity(l.variantId, v); }} />
                    <button type="button" className="link small" onClick={() => remove(l.variantId)}>{t('cart.remove')}</button>
                  </div>
                  {q && !q.inStock && <p className="err" role="alert">{q.available > 0 ? t('cart.left', { n: trimQty(String(q.available)), unit: l.unit }) : t('cart.soldOutRemove')}</p>}
                </div>
                <div className="price">{q ? money(q.totalMinor) : '…'}</div>
              </div>
            );
          })}
        </div>
        <aside className="card summary stack" aria-label={t('checkout.orderSummary')}>
          <h2>{t('cart.summary')}</h2>
          {quote?.trade && <p className="notice small">{t('cart.trade')}</p>}
          {problem && <p className="err" role="alert">{problem}</p>}
          <dl>
            <dt>{t('cart.subtotal')}</dt><dd>{quote ? money(quote.subtotalMinor) : '—'}</dd>
            {quote?.coupon && <><dt className="ok">{t('cart.couponOff', { code: quote.coupon.code, pct: quote.coupon.percentBps / 100 })}</dt><dd className="ok">−{money(quote.discountMinor)}</dd></>}
            <dt className="muted small">{t('cart.delivery')}</dt><dd className="muted small">{t('cart.atCheckout')}</dd>
          </dl>
          {coupon ? (
            <p className="small">{t('cart.coupon')} <strong>{coupon}</strong> <button type="button" className="link" onClick={() => setCoupon('')}>{t('cart.remove')}</button></p>
          ) : (
            <form className="row" onSubmit={(e) => { e.preventDefault(); if (typed.trim()) { setCoupon(typed.trim().toUpperCase()); setTyped(''); } }}>
              <label htmlFor="coupon" className="sr-only" style={{ position: 'absolute', left: -9999 }}>{t('cart.couponCode')}</label>
              <input id="coupon" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={t('cart.couponCode')} style={{ flex: 1, minWidth: 0 }} maxLength={20} />
              <button className="btn ghost small" disabled={!typed.trim()}>{t('cart.apply')}</button>
            </form>
          )}
          <p className="small muted">{t('cart.taxNote')}</p>
          {stuck ? <button className="btn block" disabled>{t('cart.checkout')}</button> : <Link className="btn block" href="/checkout">{t('cart.checkout')}</Link>}
          <Link className="btn ghost block" href="/shop">{t('cart.continue')}</Link>
        </aside>
      </div>
    </div>
  );
}
