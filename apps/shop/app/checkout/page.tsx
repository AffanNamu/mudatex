'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { RequireShopper } from '@/components/RequireShopper';
import { ApiError, shopRequest } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useCart } from '@/lib/cart';
import { formatMoney, trimQty } from '@/lib/format';
import { T, useI18n } from '@/lib/i18n';
import type { Address, BasketQuote, Order } from '@/lib/types';

function AddressForm({ onSaved, token, first }: { onSaved: (a: Address) => void; token: string; first: boolean }) {
  const { t } = useI18n();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const get = (k: string) => String(f.get(k) ?? '').trim();
    setBusy(true); setError('');
    try {
      const a = await shopRequest<Address>('/me/addresses', { token, body: {
        label: get('label') || t('addr.defaultLabel'), recipient: get('recipient'), phone: get('phone'), line1: get('line1'), line2: get('line2') || null,
        city: get('city'), state: get('state'), countryCode: get('countryCode'), isDefault: first,
      } });
      onSaved(a);
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  return (
    <form className="card stack" onSubmit={submit}>
      <h3>{t('addr.new')}</h3>
      <div className="grid2">
        <div className="field"><label htmlFor="label">{t('addr.label')}</label><input id="label" name="label" placeholder={t('addr.labelPh')} /></div>
        <div className="field"><label htmlFor="recipient">{t('addr.recipient')}</label><input id="recipient" name="recipient" required autoComplete="name" /></div>
      </div>
      <div className="field"><label htmlFor="phone">{t('addr.phone')}</label><input id="phone" name="phone" type="tel" required autoComplete="tel" /></div>
      <div className="field"><label htmlFor="line1">{t('addr.address')}</label><input id="line1" name="line1" required autoComplete="address-line1" /></div>
      <div className="field"><label htmlFor="line2">{t('addr.landmark')}</label><input id="line2" name="line2" autoComplete="address-line2" /></div>
      <div className="grid2">
        <div className="field"><label htmlFor="city">{t('addr.city')}</label><input id="city" name="city" required autoComplete="address-level2" /></div>
        <div className="field"><label htmlFor="state">{t('addr.state')}</label><input id="state" name="state" required autoComplete="address-level1" /></div>
      </div>
      <div className="field"><label htmlFor="countryCode">{t('addr.country')}</label>
        <select id="countryCode" name="countryCode" defaultValue="NG">{(['NG', 'GH', 'NE', 'CM', 'TD'] as const).map((c) => <option key={c} value={c}>{t(`country.${c}`)}</option>)}</select>
      </div>
      {error && <p className="err" role="alert">{error}</p>}
      <button className="btn" disabled={busy}>{busy ? t('addr.saving') : t('addr.save')}</button>
    </form>
  );
}

function Checkout() {
  const { token } = useAuth();
  const { lines, clear, store, coupon } = useCart();
  const router = useRouter();
  const { t } = useI18n();
  const money = (m: number) => formatMoney(m, store.currency, store.minorUnit);
  const [addresses, setAddresses] = useState<Address[] | null>(null);
  const [addressId, setAddressId] = useState<string>('');
  const [adding, setAdding] = useState(false);
  const [quote, setQuote] = useState<BasketQuote | null>(null);
  const [quoteError, setQuoteError] = useState('');
  const [method, setMethod] = useState<'bank_transfer' | 'card' | 'account'>('bank_transfer');
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
    shopRequest<BasketQuote>('/basket', { body: { lines: lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity })), ...(coupon ? { couponCode: coupon } : {}), ...(address ? { to: { countryCode: address.countryCode, state: address.state } } : {}) }, ...(token ? { token } : {}) })
      .then((q) => { if (!cancelled) { setQuote(q); setQuoteError(''); } })
      .catch((err: Error) => { if (!cancelled) { setQuote(null); setQuoteError(err.message); } });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [basket, address?.id, coupon]);

  if (!lines.length) return <div className="empty"><h1>{t('cart.emptyTitle')}</h1><Link className="btn" href="/shop">{t('checkout.browse')}</Link></div>;

  const place = async () => {
    if (!token || !address || !quote) return;
    // One key per distinct checkout, so a double click or a retry after a bad connection cannot create a second order.
    const sig = JSON.stringify([basket, address.id, method, note, coupon]);
    if (attempt.current?.sig !== sig) attempt.current = { sig, key: crypto.randomUUID() };
    setPlacing(true); setError('');
    try {
      const order = await shopRequest<Order>('/me/orders', { token, key: attempt.current.key, body: {
        lines: lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity })), addressId: address.id, paymentMethod: method, ...(coupon ? { couponCode: coupon } : {}), ...(note.trim() ? { note: note.trim() } : {}),
      } });
      clear();
      router.push(`/orders/${order.orderNo}?placed=1${method === 'card' ? '&pay=1' : ''}`);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'shortage') setError(t('checkout.shortage'));
      else setError((err as Error).message);
      setPlacing(false);
    }
  };

  return (
    <>
      <ol className="steps" aria-label={t('checkout.stepsLabel')}><li>{t('checkout.step1')}</li><li aria-current="step">{t('checkout.step2')}</li><li>{t('checkout.step3')}</li></ol>
      <div className="cartgrid">
        <div className="stack">
          <section className="card stack" aria-labelledby="ship">
            <h2 id="ship">{t('checkout.deliveryAddress')}</h2>
            {addresses === null ? <p className="muted">{t('loading')}</p> : (
              <>
                {addresses.map((a) => (
                  <label className="radio" key={a.id}>
                    <input type="radio" name="address" checked={a.id === addressId} onChange={() => setAddressId(a.id)} />
                    <span><strong>{a.label}</strong> — {a.recipient}<br /><span className="muted small">{a.line1}{a.line2 ? `, ${a.line2}` : ''}, {a.city}, {a.state}, {a.countryCode} · {a.phone}</span></span>
                  </label>
                ))}
                {adding ? <AddressForm token={token!} first={addresses.length === 0} onSaved={(a) => { setAddresses([...addresses, a]); setAddressId(a.id); setAdding(false); }} />
                  : <button type="button" className="btn ghost small" onClick={() => setAdding(true)}>{t('checkout.addNew')}</button>}
              </>
            )}
            {quoteError && address && <p className="err" role="alert">{quoteError}</p>}
            {quote?.delivery && <p className="notice">{t('checkout.deliveryTo', { state: address?.state ?? '' })} <strong>{quote.delivery.feeMinor === 0 ? t('checkout.free') : money(quote.delivery.feeMinor)}</strong> · {t('checkout.arrives', { days: quote.delivery.etaDays.min === quote.delivery.etaDays.max ? quote.delivery.etaDays.min : `${quote.delivery.etaDays.min}–${quote.delivery.etaDays.max}` })}{quote.delivery.freeOverMinor && quote.delivery.feeMinor > 0 ? ` · ${t('checkout.freeOver', { amount: money(quote.delivery.freeOverMinor) })}` : ''}</p>}
          </section>

          <section className="card stack" aria-labelledby="pay">
            <h2 id="pay">{t('checkout.payment')}</h2>
            <label className="radio"><input type="radio" name="pay" checked={method === 'bank_transfer'} onChange={() => setMethod('bank_transfer')} />
              <span><strong>{t('checkout.bank')}</strong><br /><span className="muted small">{t('checkout.bankText')}</span></span></label>
            {quote?.trade && (
              <label className="radio"><input type="radio" name="pay" checked={method === 'account'} disabled={quote.totalMinor == null || quote.totalMinor > quote.trade.creditAvailableMinor} onChange={() => setMethod('account')} />
                <span><strong>{t('checkout.onAccount')}</strong> <span className="chip">{t('checkout.tradeChip')}</span><br /><span className="muted small">{t('checkout.onAccountText', { amount: money(quote.trade.creditAvailableMinor) })}{quote.totalMinor != null && quote.totalMinor > quote.trade.creditAvailableMinor ? ` ${t('checkout.aboveCredit')}` : ''}</span></span></label>
            )}
            <label className="radio" aria-disabled={!store.cardPayments}><input type="radio" name="pay" checked={method === 'card'} disabled={!store.cardPayments} onChange={() => setMethod('card')} />
              <span><strong>{t('checkout.card')}</strong><br /><span className="muted small">{store.cardPayments ? t('checkout.cardText') : t('checkout.comingSoon')}</span></span></label>
          </section>

          <section className="card stack"><h2>{t('checkout.note')}</h2>
            <label htmlFor="note" className="small muted" style={{ fontWeight: 400 }}>{t('checkout.noteHint')}</label>
            <textarea id="note" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
          </section>
        </div>

        <aside className="card summary stack" aria-label={t('checkout.orderSummary')}>
          <h2>{t('checkout.orderSummary')}</h2>
          {quote?.lines.map((l) => <div className="row spread small" key={l.variantId}><span>{l.title} × {trimQty(l.quantity)}</span><span>{money(l.totalMinor)}</span></div>)}
          <dl>
            <dt>{t('cart.subtotal')}</dt><dd>{quote ? money(quote.subtotalMinor) : '—'}</dd>
            {quote?.coupon && <><dt className="ok">{t('order.couponSaved', { code: quote.coupon.code })}</dt><dd className="ok">−{money(quote.discountMinor)}</dd></>}
            <dt>{t('cart.delivery')}</dt><dd>{quote?.deliveryFeeMinor != null ? (quote.deliveryFeeMinor === 0 ? t('checkout.free') : money(quote.deliveryFeeMinor)) : t('checkout.chooseAddress')}</dd>
          </dl>
          <dl className="total"><dt>{t('checkout.total')}</dt><dd>{quote?.totalMinor != null ? money(quote.totalMinor) : '—'}</dd></dl>
          {quote && !quote.allInStock && <p className="err" role="alert">{t('checkout.unavailable')} <Link href="/cart">{t('checkout.reviewBasket')}</Link>.</p>}
          {error && <p className="err" role="alert">{error}</p>}
          <button className="btn block" disabled={placing || !address || quote?.totalMinor == null || !quote.allInStock} onClick={place}>{placing ? t('checkout.placing') : t('checkout.place')}</button>
          <p className="small muted">{t('checkout.agree')} <Link href="/delivery">{t('checkout.policy')}</Link>.</p>
        </aside>
      </div>
    </>
  );
}

export default function CheckoutPage() {
  return <div className="wrap section"><h1><T k="checkout.title" /></h1><RequireShopper><Checkout /></RequireShopper></div>;
}
