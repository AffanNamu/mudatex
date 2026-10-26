'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { shopRequest } from '@/lib/api';
import { useCart } from '@/lib/cart';
import { formatMoney, trimQty } from '@/lib/format';
import type { BasketQuote } from '@/lib/types';

export default function CartPage() {
  const { lines, setQuantity, remove, store } = useCart();
  const [quote, setQuote] = useState<BasketQuote | null>(null);
  const [problem, setProblem] = useState('');
  const key = JSON.stringify(lines.map((l) => [l.variantId, l.quantity]));
  const money = (m: number) => formatMoney(m, store.currency, store.minorUnit);

  useEffect(() => {
    if (!lines.length) { setQuote(null); setProblem(''); return; }
    let cancelled = false;
    const t = setTimeout(() => {
      shopRequest<BasketQuote>('/basket', { body: { lines: lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity })) } })
        .then((q) => { if (!cancelled) { setQuote(q); setProblem(''); } })
        .catch((err: Error) => { if (!cancelled) { setQuote(null); setProblem(err.message); } });
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (!lines.length) {
    return <div className="wrap empty"><h1>Your basket is empty</h1><p className="muted">Fabrics you add will wait for you here.</p><Link className="btn" href="/shop">Start shopping</Link></div>;
  }
  const byId = new Map(quote?.lines.map((l) => [l.variantId, l]));
  const stuck = !quote || !quote.allInStock;

  return (
    <div className="wrap section">
      <h1>Your basket</h1>
      <div className="cartgrid">
        <div>
          {lines.map((l) => {
            const q = byId.get(l.variantId);
            return (
              <div className="line" key={l.variantId}>
                <div className="thumb">{l.image ? <img src={l.image} alt="" /> : <div className="placeholder" aria-hidden="true">{l.title.slice(0, 1)}</div>}</div>
                <div>
                  <Link href={`/product/${l.productSlug}`}><strong>{l.title}</strong></Link>
                  <div className="small muted">{l.sku}</div>
                  <div className="row" style={{ marginTop: 8 }}>
                    <label className="small" htmlFor={`q-${l.variantId}`} style={{ margin: 0 }}>Qty ({l.unit})</label>
                    <input id={`q-${l.variantId}`} style={{ width: 90, minHeight: 36 }} inputMode="decimal" value={l.quantity}
                      onChange={(e) => setQuantity(l.variantId, e.target.value)} onBlur={(e) => { const v = trimQty(e.target.value); if (!(Number(v) > 0)) remove(l.variantId); else setQuantity(l.variantId, v); }} />
                    <button type="button" className="link small" onClick={() => remove(l.variantId)}>Remove</button>
                  </div>
                  {q && !q.inStock && <p className="err" role="alert">{q.available > 0 ? `Only ${trimQty(String(q.available))} ${l.unit} left — reduce the quantity.` : 'Sold out — remove it to continue.'}</p>}
                </div>
                <div className="price">{q ? money(q.totalMinor) : '…'}</div>
              </div>
            );
          })}
        </div>
        <aside className="card summary stack" aria-label="Order summary">
          <h2>Summary</h2>
          {problem && <p className="err" role="alert">{problem}</p>}
          <dl>
            <dt>Subtotal</dt><dd>{quote ? money(quote.subtotalMinor) : '—'}</dd>
            <dt className="muted small">Delivery</dt><dd className="muted small">Calculated at checkout</dd>
          </dl>
          <p className="small muted">Prices include applicable tax. Final totals are confirmed by the shop when you place the order.</p>
          {stuck ? <button className="btn block" disabled>Checkout</button> : <Link className="btn block" href="/checkout">Checkout</Link>}
          <Link className="btn ghost block" href="/shop">Continue shopping</Link>
        </aside>
      </div>
    </div>
  );
}
