import { useRef, useState } from 'react';
import { ErrorBanner, Loading, Notice, PageHeader } from '../components/ui';
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
