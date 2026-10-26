'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { RequireShopper } from '@/components/RequireShopper';
import { ApiError, shopRequest } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useCart } from '@/lib/cart';
import { formatMoney, trimQty } from '@/lib/format';
import type { Address, BasketQuote, Order } from '@/lib/types';

function AddressForm({ onSaved, token, first }: { onSaved: (a: Address) => void; token: string; first: boolean }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const get = (k: string) => String(f.get(k) ?? '').trim();
    setBusy(true); setError('');
    try {
      const a = await shopRequest<Address>('/me/addresses', { token, body: {
        label: get('label') || 'Home', recipient: get('recipient'), phone: get('phone'), line1: get('line1'), line2: get('line2') || null,
        city: get('city'), state: get('state'), countryCode: get('countryCode'), isDefault: first,
      } });
      onSaved(a);
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  return (
    <form className="card stack" onSubmit={submit}>
      <h3>New delivery address</h3>
      <div className="grid2">
        <div className="field"><label htmlFor="label">Label</label><input id="label" name="label" placeholder="Home, Shop…" /></div>
        <div className="field"><label htmlFor="recipient">Recipient</label><input id="recipient" name="recipient" required autoComplete="name" /></div>
      </div>
      <div className="field"><label htmlFor="phone">Phone</label><input id="phone" name="phone" type="tel" required autoComplete="tel" /></div>
      <div className="field"><label htmlFor="line1">Address</label><input id="line1" name="line1" required autoComplete="address-line1" /></div>
      <div className="field"><label htmlFor="line2">Landmark / apartment (optional)</label><input id="line2" name="line2" autoComplete="address-line2" /></div>
      <div className="grid2">
        <div className="field"><label htmlFor="city">City</label><input id="city" name="city" required autoComplete="address-level2" /></div>
        <div className="field"><label htmlFor="state">State</label><input id="state" name="state" required autoComplete="address-level1" /></div>
      </div>
      <div className="field"><label htmlFor="countryCode">Country</label>
        <select id="countryCode" name="countryCode" defaultValue="NG"><option value="NG">Nigeria</option><option value="GH">Ghana</option><option value="NE">Niger</option><option value="CM">Cameroon</option><option value="TD">Chad</option></select>
      </div>
      {error && <p className="err" role="alert">{error}</p>}
      <button className="btn" disabled={busy}>{busy ? 'Saving…' : 'Save address'}</button>
    </form>
  );
}

function Checkout() {
  const { token } = useAuth();
  const { lines, clear, store } = useCart();
  const router = useRouter();
  const money = (m: number) => formatMoney(m, store.currency, store.minorUnit);
  const [addresses, setAddresses] = useState<Address[] | null>(null);
  const [addressId, setAddressId] = useState<string>('');
  const [adding, setAdding] = useState(false);
  const [quote, setQuote] = useState<BasketQuote | null>(null);
  const [quoteError, setQuoteError] = useState('');
  const [method, setMethod] = useState<'bank_transfer' | 'card'>('bank_transfer');
  const [note, setNote] = useState('');
  const [placing, setPlacing] = useState(false);
  const [error, setError] = useState('');
  const attempt = useRef<{ sig: string; key: string } | null>(null);

  useEffect(() => {
    if (!token) return;
    shopRequest<Address[]>('/me/addresses', { token }).then((list) => {
      setAddresses(list);
      setAddressId((cur) => cur || list.find((a) => a.isDefault)?.id || list[0]?.id || '');
      if (!list.length) setAdding(true);
    }).catch(() => setAddresses([]));
  }, [token]);

  const address = addresses?.find((a) => a.id === addressId);
  const basket = useMemo(() => JSON.stringify(lines.map((l) => [l.variantId, l.quantity])), [lines]);

  useEffect(() => {
    if (!lines.length) return;
    let cancelled = false;
    shopRequest<BasketQuote>('/basket', { body: { lines: lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity })), ...(address ? { to: { countryCode: address.countryCode, state: address.state } } : {}) } })
      .then((q) => { if (!cancelled) { setQuote(q); setQuoteError(''); } })
      .catch((err: Error) => { if (!cancelled) { setQuote(null); setQuoteError(err.message); } });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [basket, address?.id]);

  if (!lines.length) return <div className="empty"><h1>Your basket is empty</h1><Link className="btn" href="/shop">Browse the shop</Link></div>;

  const place = async () => {
    if (!token || !address || !quote) return;
    // One key per distinct checkout, so a double click or a retry after a bad connection cannot create a second order.
    const sig = JSON.stringify([basket, address.id, method, note]);
    if (attempt.current?.sig !== sig) attempt.current = { sig, key: crypto.randomUUID() };
    setPlacing(true); setError('');
    try {
      const order = await shopRequest<Order>('/me/orders', { token, key: attempt.current.key, body: {
        lines: lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity })), addressId: address.id, paymentMethod: method, ...(note.trim() ? { note: note.trim() } : {}),
      } });
      clear();
      router.push(`/orders/${order.orderNo}?placed=1`);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'shortage') setError('Some items just sold out or are low. Review your basket and try again.');
      else setError((err as Error).message);
      setPlacing(false);
    }
  };

  return (
    <>
      <ol className="steps" aria-label="Checkout steps"><li>Basket</li><li aria-current="step">Delivery &amp; payment</li><li>Confirmation</li></ol>
      <div className="cartgrid">
        <div className="stack">
          <section className="card stack" aria-labelledby="ship">
            <h2 id="ship">1. Delivery address</h2>
            {addresses === null ? <p className="muted">Loading…</p> : (
              <>
                {addresses.map((a) => (
                  <label className="radio" key={a.id}>
                    <input type="radio" name="address" checked={a.id === addressId} onChange={() => setAddressId(a.id)} />
                    <span><strong>{a.label}</strong> — {a.recipient}<br /><span className="muted small">{a.line1}{a.line2 ? `, ${a.line2}` : ''}, {a.city}, {a.state}, {a.countryCode} · {a.phone}</span></span>
                  </label>
                ))}
                {adding ? <AddressForm token={token!} first={addresses.length === 0} onSaved={(a) => { setAddresses([...addresses, a]); setAddressId(a.id); setAdding(false); }} />
                  : <button type="button" className="btn ghost small" onClick={() => setAdding(true)}>+ Add a new address</button>}
              </>
            )}
            {quoteError && address && <p className="err" role="alert">{quoteError}</p>}
            {quote?.delivery && <p className="notice">Delivery to {address?.state}: <strong>{quote.delivery.feeMinor === 0 ? 'Free' : money(quote.delivery.feeMinor)}</strong> · arrives in {quote.delivery.etaDays.min === quote.delivery.etaDays.max ? quote.delivery.etaDays.min : `${quote.delivery.etaDays.min}–${quote.delivery.etaDays.max}`} days{quote.delivery.freeOverMinor && quote.delivery.feeMinor > 0 ? ` · free over ${money(quote.delivery.freeOverMinor)}` : ''}</p>}
          </section>

          <section className="card stack" aria-labelledby="pay">
            <h2 id="pay">2. Payment</h2>
            <label className="radio"><input type="radio" name="pay" checked={method === 'bank_transfer'} onChange={() => setMethod('bank_transfer')} />
              <span><strong>Bank transfer</strong><br /><span className="muted small">We show you our account details next. Your order is held for 24 hours while you pay, then shipped as soon as we confirm it.</span></span></label>
            <label className="radio" aria-disabled="true"><input type="radio" name="pay" disabled /><span><strong>Card or online banking</strong><br /><span className="muted small">Coming soon.</span></span></label>
          </section>

          <section className="card stack"><h2>3. Note (optional)</h2>
            <label htmlFor="note" className="small muted" style={{ fontWeight: 400 }}>Anything we should know — cutting instructions, gift wrapping…</label>
            <textarea id="note" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
          </section>
        </div>

        <aside className="card summary stack" aria-label="Order summary">
          <h2>Order summary</h2>
          {quote?.lines.map((l) => <div className="row spread small" key={l.variantId}><span>{l.title} × {trimQty(l.quantity)}</span><span>{money(l.totalMinor)}</span></div>)}
          <dl>
            <dt>Subtotal</dt><dd>{quote ? money(quote.subtotalMinor) : '—'}</dd>
            <dt>Delivery</dt><dd>{quote?.deliveryFeeMinor != null ? (quote.deliveryFeeMinor === 0 ? 'Free' : money(quote.deliveryFeeMinor)) : 'Choose an address'}</dd>
          </dl>
          <dl className="total"><dt>Total</dt><dd>{quote?.totalMinor != null ? money(quote.totalMinor) : '—'}</dd></dl>
          {quote && !quote.allInStock && <p className="err" role="alert">Some items are not available in these quantities. <Link href="/cart">Review your basket</Link>.</p>}
          {error && <p className="err" role="alert">{error}</p>}
          <button className="btn block" disabled={placing || !address || quote?.totalMinor == null || !quote.allInStock} onClick={place}>{placing ? 'Placing your order…' : 'Place order'}</button>
          <p className="small muted">By placing an order you agree to our <Link href="/delivery">delivery &amp; returns policy</Link>.</p>
        </aside>
      </div>
    </>
  );
}

export default function CheckoutPage() {
  return <div className="wrap section"><h1>Checkout</h1><RequireShopper><Checkout /></RequireShopper></div>;
}
