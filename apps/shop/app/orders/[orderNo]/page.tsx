'use client';

import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { RequireShopper } from '@/components/RequireShopper';
import { shopRequest } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useCart } from '@/lib/cart';
import { formatMoney, STATUS_LABEL, trimQty, whatsappLink } from '@/lib/format';
import type { Order } from '@/lib/types';

function OrderView() {
  const { orderNo } = useParams<{ orderNo: string }>();
  const search = useSearchParams();
  const placed = search.get('placed') === '1';
  const autoPay = search.get('pay') === '1';
  const returned = search.get('reference');
  const { token } = useAuth();
  const { store } = useCart();
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
    setPayNote('Confirming your payment…');
    shopRequest<{ outcome: string; order: Order }>(`/me/orders/${orderNo}/payment-check`, { token, body: { reference } })
      .then((r) => {
        setOrder(r.order);
        setPayNote(r.outcome === 'succeeded' ? '' : r.outcome === 'pending' ? 'We have not received confirmation yet. You can check again in a moment.' : 'The payment did not go through, and nothing has been taken for this order. You can try again.');
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

  if (error) return <div className="empty"><h1>We couldn&apos;t find that order</h1><Link className="btn" href="/account/orders">Your orders</Link></div>;
  if (!order) return <p className="muted" role="status">Loading…</p>;

  const cancel = async () => {
    if (!token || !confirm('Cancel this order?')) return;
    setBusy(true);
    try { setOrder(await shopRequest<Order>(`/me/orders/${orderNo}/cancel`, { method: 'POST', token })); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const c = store.contact;
  const wa = whatsappLink(c.whatsapp, `Hello, my order is ${order.orderNo}.`);
  const waiting = order.status === 'pending_payment';

  return (
    <div className="stack">
      {placed && <div className="notice" role="status"><strong>Thank you — your order {order.orderNo} is placed.</strong> {waiting && 'Pay by bank transfer below to confirm it.'}</div>}
      <div className="row spread"><h1 style={{ margin: 0 }}>Order {order.orderNo}</h1><span className={`status ${order.status}`}>{STATUS_LABEL[order.status] ?? order.status}</span></div>

      {payNote && <p className="notice" role="status">{payNote}</p>}
      {waiting && order.paymentMethod === 'card' && (
        <section className="card stack" aria-labelledby="cardpay">
          <h2 id="cardpay">Pay {money(order.totalMinor)} by card</h2>
          <p className="muted">You will go to Paystack&apos;s secure page and come straight back. We hold your fabric until {new Date(order.expiresAt).toLocaleTimeString()}.</p>
          <div className="row"><button className="btn" onClick={payNow} disabled={busy}>{busy ? 'Opening payment page…' : 'Pay now'}</button>
            {returned && <button className="btn ghost" onClick={() => check(returned)}>Check again</button>}</div>
        </section>
      )}
      {waiting && order.paymentMethod === 'bank_transfer' && (
        <section className="card stack" aria-labelledby="transfer">
          <h2 id="transfer">Pay by bank transfer</h2>
          <p>Transfer exactly <strong>{money(order.totalMinor)}</strong> and use <strong>{order.orderNo}</strong> as the payment reference.</p>
          {c.accountNumber ? (
            <table className="facts"><tbody>
              <tr><th scope="row">Bank</th><td>{c.bankName}</td></tr>
              <tr><th scope="row">Account name</th><td>{c.accountName}</td></tr>
              <tr><th scope="row">Account number</th><td><strong>{c.accountNumber}</strong></td></tr>
            </tbody></table>
          ) : <p className="muted">Our account details will be sent to you on WhatsApp.</p>}
          <p className="small muted">We hold your fabric until {new Date(order.expiresAt).toLocaleString()}. After that the order lapses and the stock is released.</p>
          {wa && <a className="btn ghost" href={wa} target="_blank" rel="noopener noreferrer">Send payment proof on WhatsApp</a>}
        </section>
      )}

      <div className="cartgrid">
        <section className="card" aria-labelledby="items">
          <h2 id="items">Items</h2>
          <table className="plain"><tbody>
            {order.lines.map((l) => <tr key={l.lineNo}><td>{l.title}<div className="small muted">{trimQty(l.quantity)} × {money(Math.round(Number(l.unitPrice) * 10 ** store.minorUnit))}</div></td><td style={{ textAlign: 'right' }}>{money(l.totalMinor)}</td></tr>)}
            <tr><td className="muted">Delivery</td><td style={{ textAlign: 'right' }}>{order.deliveryFeeMinor === 0 ? 'Free' : money(order.deliveryFeeMinor)}</td></tr>
            <tr><td><strong>Total</strong></td><td style={{ textAlign: 'right' }}><strong>{money(order.totalMinor)}</strong></td></tr>
          </tbody></table>
          <h3 style={{ marginTop: 20 }}>Delivering to</h3>
          <p>{order.delivery.recipient}<br />{order.delivery.line1}{order.delivery.line2 ? `, ${order.delivery.line2}` : ''}<br />{order.delivery.city}, {order.delivery.state}</p>
          {order.trackingRef && <p><strong>Tracking:</strong> {order.carrier} {order.trackingRef}</p>}
        </section>
        <section className="card" aria-labelledby="trail">
          <h2 id="trail">Progress</h2>
          <ol className="timeline">
            {order.events.map((e, i) => <li key={i}><strong>{STATUS_LABEL[e.status] ?? e.status}</strong><div className="small muted">{new Date(e.at).toLocaleString()}</div></li>)}
          </ol>
          {waiting && <button className="btn ghost small" onClick={cancel} disabled={busy}>Cancel this order</button>}
        </section>
      </div>
    </div>
  );
}

export default function OrderPage() {
  return <div className="wrap section"><RequireShopper><Suspense><OrderView /></Suspense></RequireShopper></div>;
}
