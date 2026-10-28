'use client';

import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { RequireShopper } from '@/components/RequireShopper';
import { RepeatOrder } from '@/components/StandingOrders';
import { shopRequest } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useCart } from '@/lib/cart';
import { formatMoney, trimQty, whatsappLink } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import type { Order } from '@/lib/types';

function OrderView() {
  const { orderNo } = useParams<{ orderNo: string }>();
  const search = useSearchParams();
  const placed = search.get('placed') === '1';
  const autoPay = search.get('pay') === '1';
  const returned = search.get('reference');
  const { token } = useAuth();
  const { store, add } = useCart();
  const router = useRouter();
  const { t, lang } = useI18n();
  const [order, setOrder] = useState<Order | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [payNote, setPayNote] = useState('');
  const started = useRef(false);
  const money = (m: number) => formatMoney(m, order?.currency ?? store.currency, store.minorUnit);

  const load = useCallback(() => {
    if (!token) return;
    shopRequest<Order>(`/me/orders/${orderNo}`, { token }).then(setOrder).catch((e: Error) => setError(e.message));
  }, [token, orderNo]);
  useEffect(load, [load]);

  // Coming back from the payment page: ask the server to confirm with the provider; the browser's word is never taken.
  const check = useCallback((reference: string) => {
    if (!token) return;
    setPayNote(t('order.confirming'));
    shopRequest<{ outcome: string; order: Order }>(`/me/orders/${orderNo}/payment-check`, { token, body: { reference } })
      .then((r) => {
        setOrder(r.order);
        setPayNote(r.outcome === 'succeeded' ? '' : r.outcome === 'pending' ? t('order.notConfirmed') : t('order.failed'));
      })
      .catch((e: Error) => setPayNote(e.message));
  }, [token, orderNo]);
  useEffect(() => {
    if (!token || !returned || started.current) return;
    started.current = true;
    check(returned);
  }, [token, returned, check]);

  const payNow = useCallback(async () => {
    if (!token) return;
    setBusy(true); setPayNote('');
    try {
      const { authorizationUrl } = await shopRequest<{ authorizationUrl: string }>(`/me/orders/${orderNo}/pay`, { method: 'POST', token });
      window.location.assign(authorizationUrl);
    } catch (e) { setPayNote((e as Error).message); setBusy(false); }
  }, [token, orderNo]);

  useEffect(() => {
    if (order?.status === 'pending_payment' && order.paymentMethod === 'card' && autoPay && !returned && !started.current) { started.current = true; void payNow(); }
  }, [order, autoPay, returned, payNow]);

  if (error) return <div className="empty"><h1>{t('order.notFound')}</h1><Link className="btn" href="/account/orders">{t('order.yourOrders')}</Link></div>;
  if (!order) return <p className="muted" role="status">{t('loading')}</p>;

  const cancel = async () => {
    if (!token || !confirm(t('order.confirmCancel'))) return;
    setBusy(true);
    try { setOrder(await shopRequest<Order>(`/me/orders/${orderNo}/cancel`, { method: 'POST', token })); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const buyAgain = () => {
    for (const l of order.lines) add({ variantId: l.variantId, productSlug: l.productSlug ?? '', title: l.title, sku: l.sku, image: l.image, unit: l.unit, quantity: String(Number(l.quantity)), priceMinor: 0 });
    router.push('/cart');
  };
  const c = store.contact;
  const wa = whatsappLink(c.whatsapp, t('order.waHello', { no: order.orderNo }));
  const waiting = order.status === 'pending_payment';
  const onAccount = order.paymentMethod === 'account';

  return (
    <div className="stack">
      {placed && <div className="notice" role="status"><strong>{t('order.placed', { no: order.orderNo })}</strong> {waiting && t('order.payBelow')}</div>}
      <div className="row spread"><h1 style={{ margin: 0 }}>{t('order.title', { no: order.orderNo })}</h1><span className={`status ${order.status}`}>{t(`status.${order.status}`)}</span></div>

      {payNote && <p className="notice" role="status">{payNote}</p>}
      {onAccount && order.status !== 'cancelled' && (
        <p className="notice">{t('order.onAccount')} {order.totalMinor - order.paidMinor > 0 ? <>{t('order.balance')} <strong>{money(order.totalMinor - order.paidMinor)}</strong>{order.dueOn ? t('order.dueBy', { date: new Date(order.dueOn).toLocaleDateString() }) : null}.</> : t('order.paidFull')}</p>
      )}
      {waiting && order.paymentMethod === 'card' && (
        <section className="card stack" aria-labelledby="cardpay">
          <h2 id="cardpay">{t('order.payCard', { amount: money(order.totalMinor) })}</h2>
          <p className="muted">{t('order.cardText', { time: new Date(order.expiresAt).toLocaleTimeString() })}</p>
          <div className="row"><button className="btn" onClick={payNow} disabled={busy}>{busy ? t('order.opening') : t('order.payNow')}</button>
            {returned && <button className="btn ghost" onClick={() => check(returned)}>{t('order.checkAgain')}</button>}</div>
        </section>
      )}
      {waiting && order.paymentMethod === 'bank_transfer' && (
        <section className="card stack" aria-labelledby="transfer">
          <h2 id="transfer">{t('order.payBank')}</h2>
          <p>{t('order.transferText', { amount: money(order.totalMinor), no: order.orderNo })}</p>
          {c.accountNumber ? (
            <table className="facts"><tbody>
              <tr><th scope="row">{t('order.bank')}</th><td>{c.bankName}</td></tr>
              <tr><th scope="row">{t('order.accountName')}</th><td>{c.accountName}</td></tr>
              <tr><th scope="row">{t('order.accountNumber')}</th><td><strong>{c.accountNumber}</strong></td></tr>
            </tbody></table>
          ) : <p className="muted">{t('order.detailsWhatsapp')}</p>}
          <p className="small muted">{t('order.hold', { time: new Date(order.expiresAt).toLocaleString() })}</p>
          {wa && <a className="btn ghost" href={wa} target="_blank" rel="noopener noreferrer">{t('order.sendProof')}</a>}
        </section>
      )}

      <p><Link className="btn ghost small" href={`/orders/${order.orderNo}/invoice`}>{t('doc.link')}</Link></p>
      {order.status !== 'cancelled' && order.status !== 'expired' && order.paymentMethod !== 'card' && <RepeatOrder orderNo={order.orderNo} paymentMethod={order.paymentMethod} />}

      <div className="cartgrid">
        <section className="card" aria-labelledby="items">
          <h2 id="items">{t('order.items')}</h2>
          <table className="plain"><tbody>
            {order.lines.map((l) => <tr key={l.lineNo}><td>{l.title}<div className="small muted">{trimQty(l.quantity)} × {money(Math.round(Number(l.unitPrice) * 10 ** store.minorUnit))}</div></td><td style={{ textAlign: 'right' }}>{money(l.totalMinor)}</td></tr>)}
            {order.discountMinor > 0 && <tr><td className="ok">{t('order.couponSaved', { code: order.couponCode ?? '' })}</td><td style={{ textAlign: 'right' }} className="ok">−{t('order.saved', { amount: money(order.discountMinor) })}</td></tr>}
            <tr><td className="muted">{t('cart.delivery')}</td><td style={{ textAlign: 'right' }}>{order.deliveryFeeMinor === 0 ? t('checkout.free') : money(order.deliveryFeeMinor)}</td></tr>
            <tr><td><strong>{t('checkout.total')}</strong></td><td style={{ textAlign: 'right' }}><strong>{money(order.totalMinor)}</strong></td></tr>
          </tbody></table>
          <h3 style={{ marginTop: 20 }}>{t('order.deliveryTo')}</h3>
          <p>{order.delivery.recipient}<br />{order.delivery.line1}{order.delivery.line2 ? `, ${order.delivery.line2}` : ''}<br />{order.delivery.city}, {order.delivery.state}</p>
          {order.shipment ? (
            <section aria-labelledby="parcel" className="parcel">
              <h3 id="parcel">{t('ship.title')}</h3>
              <p><strong>{t(`ship.status.${order.shipment.status}`)}</strong>{order.shipment.eta && order.shipment.status !== 'delivered' ? <> · {t('ship.eta', { date: new Date(`${order.shipment.eta}T12:00:00`).toLocaleDateString(lang) })}</> : null}</p>
              <p className="small">{t('ship.carrier', { name: order.shipment.carrierName })}{order.shipment.trackingRef && <><br />{t('ship.number', { ref: order.shipment.trackingRef })}</>}</p>
              {order.shipment.trackingUrl && <p><a className="btn ghost small" href={order.shipment.trackingUrl} target="_blank" rel="noopener noreferrer">{t('ship.track', { name: order.shipment.carrierName })}</a></p>}
              {order.shipment.events.length ? (
                <ol className="timeline">
                  {order.shipment.events.map((e, i) => (
                    <li key={i}><strong>{e.status ? t(`ship.status.${e.status}`) : t('ship.update')}</strong>{e.description && <> — {e.description}</>}
                      <div className="small muted">{e.location ? `${e.location} · ` : ''}{new Date(e.at).toLocaleString(lang)}</div></li>
                  ))}
                </ol>
              ) : <p className="small muted">{t('ship.noUpdates')}</p>}
            </section>
          ) : order.trackingRef && <p><strong>{t('order.tracking')}</strong> {order.carrier} {order.trackingRef}</p>}
        </section>
        <section className="card" aria-labelledby="trail">
          <h2 id="trail">{t('order.progress')}</h2>
          <ol className="timeline">
            {order.events.map((e, i) => <li key={i}><strong>{t(`status.${e.status}`)}</strong><div className="small muted">{new Date(e.at).toLocaleString()}</div></li>)}
          </ol>
          {waiting && <button className="btn ghost small" onClick={cancel} disabled={busy}>{t('order.cancel')}</button>}
          <button className="btn ghost small" onClick={buyAgain} style={{ marginTop: 8 }}>{t('order.buyAgain')}</button>
        </section>
      </div>
    </div>
  );
}

export default function OrderPage() {
  return <div className="wrap section"><RequireShopper><Suspense><OrderView /></Suspense></RequireShopper></div>;
}
