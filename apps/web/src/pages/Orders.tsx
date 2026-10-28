import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ErrorBanner, Field, Loading, Notice, PageHeader } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useDebounced, useLoad } from '../lib/hooks';
import type { Carrier } from './DeliveryCompanies';
import { formatMoney } from '../lib/money';

const STATUSES = [['', 'All'], ['pending_payment', 'Awaiting payment'], ['confirmed', 'On account'], ['paid', 'Paid'], ['processing', 'Preparing'], ['shipped', 'Shipped'], ['delivered', 'Delivered'], ['cancelled', 'Cancelled'], ['expired', 'Expired']] as const;
const LABEL = Object.fromEntries(STATUSES.map(([v, l]) => [v, l]));

interface Row { minorUnit: number; id: string; orderNo: string; status: string; currency: string; totalMinor: number; paidMinor: number; paymentMethod: string; customerName: string; placedAt: string }
interface Detail {
  minorUnit: number;
  id: string; orderNo: string; status: string; currency: string; subtotalMinor: number; deliveryFeeMinor: number; totalMinor: number; paidMinor: number; refundDueMinor: number;
  paymentMethod: string; dueOn: string | null; contact: { name: string; email: string; phone: string | null }; note: string | null; carrier: string | null; trackingRef: string | null; cancelReason: string | null; expiresAt: string;
  delivery: { recipient: string; phone: string; line1: string; line2: string | null; city: string; state: string; countryCode: string; zone: string };
  lines: { lineNo: number; title: string; sku: string; quantity: string; totalMinor: number }[];
  events: { status: string; actorType: string; note: string | null; at: string }[];
  payments: { method: string; reference: string; amountMinor: number; at: string }[];
  refunds: { id: string; amountMinor: number; reason: string; method: string; status: string; requestedBy: string; payoutRef: string | null; detail: string | null }[];
  shipFrom?: string[];
  shipment: { status: string; carrierName: string; trackingRef: string | null; trackingUrl: string | null; eta: string | null; events: { status: string | null; description: string | null; location: string | null; at: string }[] } | null;
}

/** Online orders: confirm that money arrived, prepare, ship (which takes stock off the shelf), deliver, or cancel. */
export function Orders() {
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 300);
  const params = new URLSearchParams({ limit: '50' });
  if (status) params.set('status', status);
  if (dq.trim()) params.set('q', dq.trim());
  const list = useLoad<{ total: number; items: Row[] }>(`/v1/sales-orders?${params}`);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      <PageHeader title="Online orders" />
      <ErrorBanner error={list.error} />
      <div className="toolbar">
        <label className="field inline"><span className="field-label">Status</span><select value={status} onChange={(e) => setStatus(e.target.value)}>{STATUSES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
        <label className="field inline"><span className="field-label">Search</span><input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Order no., name, email, phone" /></label>
      </div>
      {list.loading && !list.data ? <Loading what="orders" /> : (
        <div className="table-wrap"><table>
          <caption className="sr-only">Online orders</caption>
          <thead><tr><th scope="col">Order</th><th scope="col">Customer</th><th scope="col">Placed</th><th scope="col">Total</th><th scope="col">Status</th></tr></thead>
          <tbody>
            {(list.data?.items ?? []).map((o) => (
              <tr key={o.id}>
                <th scope="row"><button className="btn btn-ghost" aria-expanded={open === o.id} onClick={() => setOpen(open === o.id ? null : o.id)}>{o.orderNo}</button></th>
                <td>{o.customerName}</td><td>{new Date(o.placedAt).toLocaleString()}</td>
                <td>{formatMoney(o.totalMinor, o.currency, o.minorUnit)}</td><td>{LABEL[o.status] ?? o.status}</td>
              </tr>
            ))}
            {list.data?.items.length === 0 && <tr><td colSpan={5} className="muted">No orders{status || q ? ' match' : ' yet'}.</td></tr>}
          </tbody>
        </table></div>
      )}
      {open && <OrderPanel key={open} id={open} onChanged={list.reload} />}
    </>
  );
}

function OrderPanel({ id, onChanged }: { id: string; onChanged(): void }) {
  const { can, session } = useAuth();
  const d = useLoad<Detail>(`/v1/sales-orders/${id}`);
  const carriers = useLoad<Carrier[]>(can('orders.fulfil') ? '/v1/carriers' : null);
  const [carrierId, setCarrierId] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [ref, setRef] = useState(''); const [amount, setAmount] = useState(''); const [carrier, setCarrier] = useState(''); const [tracking, setTracking] = useState(''); const [reason, setReason] = useState('');
  const o = d.data;
  const money = (m: number) => formatMoney(m, o?.currency ?? 'NGN', o?.minorUnit ?? 2);
  const refSeed = useRef(0);

  async function post(path: string, body: unknown) {
    setBusy(true); setError(null);
    try { await api(`/v1/sales-orders/${id}/${path}`, { method: 'POST', body }); d.reload(); onChanged(); setRef(''); setReason(''); refSeed.current++; }
    catch (e) { setError(e); } finally { setBusy(false); }
  }
  if (!o) return <><ErrorBanner error={d.error} />{d.loading && <Loading what="the order" />}</>;
  const step = (action: 'process' | 'ship' | 'deliver') => post('steps', { action, ...(action === 'ship' ? { ...(carrierId ? { carrierId } : carrier.trim() ? { carrier: carrier.trim() } : {}), ...(tracking.trim() ? { trackingRef: tracking.trim() } : {}) } : {}) });
  const companies = (carriers.data ?? []).filter((c) => c.active);
  const chosen = companies.find((c) => c.id === carrierId);
  const pay = (e: FormEvent) => { e.preventDefault(); return post('payments', { method: o.paymentMethod === 'account' ? 'bank_transfer' : o.paymentMethod, reference: ref.trim(), amountMinor: o.paymentMethod === 'account' ? Math.round(Number(amount) * 10 ** o.minorUnit) : o.totalMinor - o.paidMinor }); };
  const owing = o.totalMinor - o.paidMinor;

  return (
    <section className="panel" aria-label={`Order ${o.orderNo}`}>
      <h2>{o.orderNo} <span className="chip">{LABEL[o.status] ?? o.status}</span></h2>
      <p>{o.contact.name} · {o.contact.phone ?? '—'} · {o.contact.email}<br />
        Deliver to {o.delivery.recipient}, {o.delivery.line1}{o.delivery.line2 ? `, ${o.delivery.line2}` : ''}, {o.delivery.city}, {o.delivery.state} ({o.delivery.zone}) · {o.delivery.phone}</p>
      {o.note && <Notice>Customer note: {o.note}</Notice>}
      <div className="table-wrap"><table>
        <thead><tr><th scope="col">Item</th><th scope="col">Qty</th><th scope="col">Total</th></tr></thead>
        <tbody>
          {o.lines.map((l) => <tr key={l.lineNo}><th scope="row">{l.title}<div className="muted">{l.sku}</div></th><td>{l.quantity}</td><td>{money(l.totalMinor)}</td></tr>)}
          <tr><th scope="row">Delivery</th><td /><td>{money(o.deliveryFeeMinor)}</td></tr>
          <tr><th scope="row">Total</th><td /><td><strong>{money(o.totalMinor)}</strong></td></tr>
        </tbody>
      </table></div>
      {o.shipFrom?.length ? <p className="muted">{['shipped', 'delivered'].includes(o.status) ? 'Sent' : 'Will be sent'} from {o.shipFrom.join(' and ')}.</p> : null}
      <ErrorBanner error={error} />

      {o.paymentMethod === 'account' && o.status !== 'cancelled' && o.status !== 'expired' && can('orders.payment.record') && (
        <form className="form-grid" onSubmit={pay}>
          <p className="muted">On the customer&apos;s trade account. Owing {money(owing)}{o.dueOn ? `, due ${o.dueOn}` : ''}.</p>
          {owing > 0 && <>
            <Field label="Amount received"><input required inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
            <Field label="Bank reference" hint="A reference can be used once."><input required minLength={4} value={ref} onChange={(e) => setRef(e.target.value)} /></Field>
            <div className="form-actions"><button className="btn btn-primary" disabled={busy || ref.trim().length < 4 || !(Number(amount) > 0)}>Record payment</button></div>
          </>}
        </form>
      )}
      {o.status === 'pending_payment' && can('orders.payment.record') && (
        <form className="form-grid" onSubmit={pay}>
          <Field label={`Bank reference of the ${money(o.totalMinor)} transfer`} hint="Check it against the bank statement first. A reference can be used for one order only."><input required minLength={4} value={ref} onChange={(e) => setRef(e.target.value)} /></Field>
          <div className="form-actions"><button className="btn btn-primary" disabled={busy || ref.trim().length < 4}>Confirm payment received</button></div>
          <p className="muted">Hold expires {new Date(o.expiresAt).toLocaleString()}.</p>
        </form>
      )}
      {can('orders.fulfil') && (
        <div className="row">
          {(o.status === 'paid' || o.status === 'confirmed') && <button className="btn" disabled={busy} onClick={() => step('process')}>Start preparing</button>}
          {(o.status === 'paid' || o.status === 'confirmed' || o.status === 'processing') && (
            <form className="form-grid" onSubmit={(e) => { e.preventDefault(); step('ship'); }}>
              {companies.length > 0 && (
                <Field label="Delivery company">
                  <select value={carrierId} onChange={(e) => setCarrierId(e.target.value)}><option value="">Another courier (type the name)</option>{companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
                </Field>
              )}
              {!carrierId && <Field label="Courier"><input value={carrier} onChange={(e) => setCarrier(e.target.value)} maxLength={80} /></Field>}
              <Field label="Tracking number" hint={chosen?.kind === 'api' ? 'Leave empty: the delivery company gives it when the parcel is booked.' : undefined}><input value={tracking} onChange={(e) => setTracking(e.target.value)} maxLength={100} /></Field>
              <div className="form-actions"><button className="btn btn-primary" disabled={busy}>Ship — take stock off the shelf</button></div>
            </form>
          )}
          {o.status === 'shipped' && <button className="btn btn-primary" disabled={busy} onClick={() => step('deliver')}>Mark delivered</button>}
        </div>
      )}
      {['pending_payment', 'confirmed', 'paid', 'processing'].includes(o.status) && can('orders.cancel') && (
        <details><summary>Cancel this order</summary>
          <form className="form-grid" onSubmit={(e) => { e.preventDefault(); post('cancel', { reason: reason.trim() }); }}>
            <Field label="Reason" hint={o.paidMinor > 0 ? `${money(o.paidMinor)} was paid and will be recorded as owed back to the customer.` : 'The reserved stock is released.'}><input required minLength={5} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
            <div className="form-actions"><button className="btn" disabled={busy || reason.trim().length < 5}>Cancel order</button></div>
          </form>
        </details>
      )}
      <PrintInvoice id={o.id} />
      <Refunds o={o} money={money} me={session?.user.id ?? ''} onChanged={() => { d.reload(); onChanged(); }} />
      {o.refundDueMinor > 0 && <Notice tone="warn">Refund owed to the customer: {money(o.refundDueMinor)}. Refunds are paid out manually for now.</Notice>}
      {o.shipment ? <ShipmentPanel o={o} orderId={o.id} onChanged={() => { d.reload(); onChanged(); }} /> : o.trackingRef && <p>Courier: {o.carrier ?? '—'} · {o.trackingRef}</p>}
      <h3>History</h3>
      <ol className="plain">{o.events.map((e, i) => <li key={i}>{new Date(e.at).toLocaleString()} — {LABEL[e.status] ?? e.status} ({e.actorType}){e.note ? ` — ${e.note}` : ''}</li>)}</ol>
      {o.payments.length > 0 && <p className="muted">Payments: {o.payments.map((p) => `${p.method} ${p.reference} ${money(p.amountMinor)}`).join('; ')}</p>}
    </section>
  );
}

const REFUND_LABEL: Record<string, string> = { requested: 'Waiting for approval', approved: 'Approved, to be paid out', processing: 'With the payment provider', paid: 'Paid', failed: 'Failed', rejected: 'Declined' };

/** Money back to the customer: one person asks, another approves. */
function Refunds({ o, money, me, onChanged }: { o: Detail; money(m: number): string; me: string; onChanged(): void }) {
  const { can } = useAuth();
  const [amount, setAmount] = useState(''); const [reason, setReason] = useState(''); const [ref, setRef] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const act = async (path: string, body: unknown) => {
    setBusy(true); setError(null);
    try { await api(path, { method: 'POST', body }); onChanged(); setAmount(''); setReason(''); } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const asked = Math.round(Number(amount) * 10 ** o.minorUnit);
  if (o.paidMinor === 0 && o.refunds.length === 0) return null;
  return (
    <details className="panel"><summary>Refunds{o.refunds.length ? ` (${o.refunds.length})` : ''}</summary>
      <ul className="plain">
        {o.refunds.map((r) => (
          <li key={r.id}>
            <strong>{money(r.amountMinor)}</strong> by {r.method.replace('_', ' ')} — {REFUND_LABEL[r.status] ?? r.status}. {r.reason}{r.detail ? ` (${r.detail})` : ''}{r.payoutRef ? ` · bank ref ${r.payoutRef}` : ''}
            {r.status === 'requested' && can('orders.refund.approve') && (r.requestedBy === me
              ? <span className="muted"> You asked for this one; someone else must approve it.</span>
              : <span className="row"><button className="btn btn-primary" disabled={busy} onClick={() => act(`/v1/refunds/${r.id}/decision`, { decision: 'approve' })}>Approve{r.method === 'card' ? ' and send to card' : ''}</button>
                  <button className="btn" disabled={busy} onClick={() => act(`/v1/refunds/${r.id}/decision`, { decision: 'reject' })}>Decline</button></span>)}
            {['approved', 'processing', 'failed'].includes(r.status) && can('orders.refund.approve') && (
              <form className="form-grid" onSubmit={(e) => { e.preventDefault(); act(`/v1/refunds/${r.id}/paid`, { payoutRef: ref[r.id] ?? '' }); }}>
                <Field label="Bank reference of the payout"><input required minLength={4} value={ref[r.id] ?? ''} onChange={(e) => setRef({ ...ref, [r.id]: e.target.value })} /></Field>
                <div className="form-actions"><button className="btn" disabled={busy || (ref[r.id] ?? '').trim().length < 4}>Mark as paid out</button></div>
              </form>
            )}
          </li>
        ))}
      </ul>
      {can('orders.refund') && o.paidMinor > 0 && (
        <form className="form-grid" onSubmit={(e) => { e.preventDefault(); act(`/v1/sales-orders/${o.id}/refunds`, { amountMinor: asked, reason: reason.trim() }); }}>
          <Field label={`Amount to refund (paid so far ${money(o.paidMinor)})`}><input required inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
          <Field label="Reason"><input required minLength={5} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} /></Field>
          <div className="form-actions"><button className="btn" disabled={busy || !(asked > 0) || reason.trim().length < 5}>Ask for this refund</button></div>
        </form>
      )}
      <ErrorBanner error={error} />
    </details>
  );
}

interface Doc {
  orderNo: string; status: string; issuedOn: string; dueOn: string | null; currency: string; minorUnit: number;
  seller: { name: string; legalName: string; address: string | null; phone: string | null; email: string | null; taxId: string | null; footer: string | null };
  buyer: { name: string; email: string; phone: string | null; businessName: string | null; taxId: string | null };
  lines: { title: string; sku: string; quantity: string; unitPrice: string; taxRatePct: string | null; totalMinor: number }[];
  taxSummary: { taxCode: string; ratePct: string; taxableMinor: number; taxMinor: number }[];
  goodsMinor: number; discountMinor: number; deliveryFeeMinor: number; totalMinor: number;
  payments: { at: string; method: string; reference: string; amountMinor: number }[];
  paidMinor: number; refundedMinor: number; balanceMinor: number;
  bank: { bankName: string | null; accountName: string | null; accountNumber: string | null } | null;
}

/** The customer's invoice or receipt, as it is printed or sent: the same figures the customer sees in the shop. */
function PrintInvoice({ id }: { id: string }) {
  const [show, setShow] = useState(false);
  const d = useLoad<Doc>(show ? `/v1/sales-orders/${id}/document` : null);
  useEffect(() => {
    if (!show) return;
    document.body.classList.add('printing-doc');
    return () => document.body.classList.remove('printing-doc');
  }, [show]);
  const doc = d.data;
  const m = (n: number) => formatMoney(n, doc?.currency ?? 'NGN', doc?.minorUnit ?? 2);
  return (
    <div className="no-print-wrap">
      <div className="row">
        <button className="btn" aria-expanded={show} onClick={() => setShow(!show)}>{show ? 'Hide invoice' : 'Invoice / receipt'}</button>
        {show && doc && <button className="btn btn-primary" onClick={() => window.print()}>Print</button>}
      </div>
      {show && <ErrorBanner error={d.error} />}
      {show && doc && (
        <article className="print-doc" aria-label={`Invoice ${doc.orderNo}`}>
          <h2>{doc.balanceMinor === 0 && doc.paidMinor > 0 ? 'Receipt' : 'Invoice'} {doc.orderNo}</h2>
          <p>{doc.seller.name}{doc.seller.legalName !== doc.seller.name ? ` (${doc.seller.legalName})` : ''}{doc.seller.address ? ` · ${doc.seller.address}` : ''}{doc.seller.phone ? ` · ${doc.seller.phone}` : ''}{doc.seller.taxId ? ` · Tax ID ${doc.seller.taxId}` : ''}<br />
            Date {doc.issuedOn}{doc.dueOn && doc.balanceMinor > 0 ? ` · Due ${doc.dueOn}` : ''}</p>
          <p>Billed to: {doc.buyer.businessName ?? doc.buyer.name}{doc.buyer.taxId ? ` · Tax ID ${doc.buyer.taxId}` : ''} · {doc.buyer.email}</p>
          <table>
            <thead><tr><th scope="col">Item</th><th scope="col">Qty</th><th scope="col">Price</th><th scope="col">Tax</th><th scope="col">Total</th></tr></thead>
            <tbody>
              {doc.lines.map((l, i) => <tr key={i}><th scope="row">{l.title}<div className="muted">{l.sku}</div></th><td>{l.quantity}</td><td>{l.unitPrice}</td><td>{l.taxRatePct ? `${l.taxRatePct}%` : '—'}</td><td>{m(l.totalMinor)}</td></tr>)}
              {doc.discountMinor > 0 && <tr><th scope="row">Discount</th><td /><td /><td /><td>−{m(doc.discountMinor)}</td></tr>}
              <tr><th scope="row">Delivery</th><td /><td /><td /><td>{m(doc.deliveryFeeMinor)}</td></tr>
              <tr><th scope="row">Total</th><td /><td /><td /><td><strong>{m(doc.totalMinor)}</strong></td></tr>
            </tbody>
          </table>
          {doc.taxSummary.length > 0 && <p>Tax included: {doc.taxSummary.map((s) => `${s.taxCode} ${s.ratePct}% on ${m(s.taxableMinor)} = ${m(s.taxMinor)}`).join('; ')}</p>}
          <p>Paid {m(doc.paidMinor)}{doc.refundedMinor ? ` · refunded ${m(doc.refundedMinor)}` : ''}{doc.balanceMinor > 0 ? ` · balance ${m(doc.balanceMinor)}` : ''}</p>
          {doc.balanceMinor > 0 && doc.bank && <p>Pay to {[doc.bank.bankName, doc.bank.accountName, doc.bank.accountNumber].filter(Boolean).join(' · ')}, reference {doc.orderNo}</p>}
          {doc.seller.footer && <p className="muted">{doc.seller.footer}</p>}
        </article>
      )}
    </div>
  );
}

const STAGES: [string, string][] = [['picked_up', 'Picked up'], ['in_transit', 'In transit'], ['out_for_delivery', 'Out for delivery'], ['delivered', 'Delivered'], ['failed', 'Delivery attempt failed'], ['returned', 'Returned to us']];
const STAGE_LABEL: Record<string, string> = { booked: 'Handed to the delivery company', cancelled: 'Cancelled', ...Object.fromEntries(STAGES) };

/** Where the parcel is, from the delivery company's updates, and a way to add one by hand. */
function ShipmentPanel({ o, orderId, onChanged }: { o: Detail; orderId: string; onChanged(): void }) {
  const { can } = useAuth();
  const sh = o.shipment!;
  const [stage, setStage] = useState('in_transit'); const [note, setNote] = useState('');
  const [error, setError] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  const add = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError(null);
    try { await api(`/v1/sales-orders/${orderId}/shipment/events`, { method: 'POST', body: { status: stage, ...(note.trim() ? { description: note.trim() } : {}) } }); setNote(''); onChanged(); }
    catch (err) { setError(err); } finally { setBusy(false); }
  };
  return (
    <section className="panel" aria-label="Parcel tracking">
      <h3>Parcel: {STAGE_LABEL[sh.status] ?? sh.status}</h3>
      <p>{sh.carrierName}{sh.trackingRef ? ` · ${sh.trackingRef}` : ''}{sh.eta ? ` · expected ${sh.eta}` : ''}{sh.trackingUrl && <> · <a href={sh.trackingUrl} target="_blank" rel="noopener noreferrer">their tracking page</a></>}</p>
      {sh.status === 'failed' && <Notice tone="warn">The delivery company could not deliver this parcel. Contact the customer and the company.</Notice>}
      {sh.status === 'returned' && <Notice tone="warn">The parcel came back. Arrange a refund or send it again.</Notice>}
      <ol className="plain">{sh.events.map((e, i) => <li key={i}>{new Date(e.at).toLocaleString()} — {e.status ? STAGE_LABEL[e.status] : 'Note'}{e.description ? `: ${e.description}` : ''}{e.location ? ` (${e.location})` : ''}</li>)}</ol>
      {can('orders.fulfil') && !['delivered', 'returned', 'cancelled'].includes(sh.status) && (
        <form className="form-grid" onSubmit={add}>
          <Field label="Add an update"><select value={stage} onChange={(e) => setStage(e.target.value)}>{STAGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
          <Field label="Note"><input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} /></Field>
          <div className="form-actions"><button className="btn" disabled={busy}>Add update</button></div>
        </form>
      )}
      <ErrorBanner error={error} />
    </section>
  );
}
