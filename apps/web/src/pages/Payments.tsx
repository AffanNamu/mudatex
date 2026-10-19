import { useRef, useState, type FormEvent } from 'react';
import { ErrorBanner, Field, Loading, Notice, PageHeader } from '../components/ui';
import { api, newKey } from '../lib/api';
import { useLoad } from '../lib/hooks';
import { formatMoney } from '../lib/money';

export interface PendingRow { id: string; receiptNumber: string; totalMinor: number; currency: string; createdAt: string }
interface Detail {
  id: string; receiptNumber: string; minorUnit: number; currency: string; totalMinor: number;
  payments: { id: string; method: string; amountMinor: number; reference: string | null; status: string }[];
}

/** Card, transfer and mobile-money sales hold stock until someone other than the cashier confirms the money arrived. */
export function Payments() {
  const pending = useLoad<PendingRow[]>('/v1/pos/sales?status=pending_payment&limit=100');
  return (
    <>
      <PageHeader title="Payments to confirm" />
      <ErrorBanner error={pending.error} />
      {pending.loading && !pending.data ? <Loading what="pending payments" /> : (pending.data ?? []).length === 0 && <Notice>Nothing is waiting for confirmation.</Notice>}
      <ul className="plain">
        {(pending.data ?? []).map((s) => <li key={s.id}><PendingSale id={s.id} onChanged={pending.reload} /></li>)}
      </ul>
      <Refunds />
    </>
  );
}

function PendingSale({ id, onChanged }: { id: string; onChanged(): void }) {
  const detail = useLoad<Detail>(`/v1/pos/sales/${id}`);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const keys = useRef<Record<string, string>>({});
  const d = detail.data;

  async function act(paymentId: string, action: 'verify' | 'fail') {
    setBusy(true); setError(null);
    const k = `${action}:${paymentId}`;
    keys.current[k] ??= newKey();
    try {
      await api(`/v1/pos/payments/${paymentId}/${action}`, { method: 'POST', idempotencyKey: keys.current[k] });
      onChanged();
    } catch (e) { setError(e); setBusy(false); }
  }

  if (!d) return <div className="card"><ErrorBanner error={detail.error} />{detail.loading && <Loading what="sale" />}</div>;
  const fmt = (m: number) => formatMoney(m, d.currency, d.minorUnit);
  return (
    <section className="card" aria-label={`Sale ${d.receiptNumber}`}>
      <h2>{d.receiptNumber} — {fmt(d.totalMinor)}</h2>
      <ErrorBanner error={error} />
      <ul className="plain">
        {d.payments.filter((p) => p.status === 'pending').map((p) => (
          <li key={p.id} className="row-between">
            <span>{p.method.replace('_', ' ')} {fmt(p.amountMinor)} · ref <strong>{p.reference}</strong></span>
            <span className="row-end">
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => act(p.id, 'verify')} aria-label={`Confirm received, ${d.receiptNumber}`}>Confirm received</button>
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => act(p.id, 'fail')} aria-label={`Not received, ${d.receiptNumber}`}>Not received</button>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

interface RefundRow { id: string; returnNumber: string; receiptNumber: string; refundMethod: string; refundTotalMinor: number; currency: string; minorUnit: number }

/** A refund by card, transfer or mobile money is paid out by someone other than the person who took the goods back. */
function Refunds() {
  const refunds = useLoad<RefundRow[]>('/v1/pos/returns?status=pending_disbursement&limit=100');
  const rows = refunds.data ?? [];
  return (
    <>
      <h2 className="section">Refunds to pay out</h2>
      <ErrorBanner error={refunds.error} />
      {!refunds.loading && rows.length === 0 && <Notice>No refunds are waiting to be paid out.</Notice>}
      <ul className="plain">{rows.map((r) => <li key={r.id}><Refund row={r} onDone={refunds.reload} /></li>)}</ul>
    </>
  );
}

function Refund({ row, onDone }: { row: RefundRow; onDone(): void }) {
  const [reference, setReference] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const key = useRef(newKey());
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { await api(`/v1/pos/returns/${row.id}/disburse`, { method: 'POST', body: { reference: reference.trim() }, idempotencyKey: key.current }); onDone(); }
    catch (err) { setError(err); setBusy(false); }
  }
  return (
    <form className="card" onSubmit={submit} aria-label={`Refund ${row.returnNumber}`}>
      <h3>{row.returnNumber} for {row.receiptNumber}: {formatMoney(row.refundTotalMinor, row.currency, row.minorUnit)} by {row.refundMethod.replace('_', ' ')}</h3>
      <ErrorBanner error={error} />
      <Field label="Payout reference"><input value={reference} onChange={(e) => { setReference(e.target.value); key.current = newKey(); }} /></Field>
      <button className="btn btn-primary" disabled={busy || !reference.trim()} aria-label={`Mark paid out, ${row.returnNumber}`}>Mark paid out</button>
    </form>
  );
}
