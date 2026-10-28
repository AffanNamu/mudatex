import { useState } from 'react';
import { ErrorBanner, Loading, Notice, PageHeader } from '../components/ui';
import { api } from '../lib/api';
import { useLoad } from '../lib/hooks';

interface Row {
  id: string; status: 'active' | 'paused' | 'cancelled'; frequency: string; paymentMethod: string; nextRunOn: string; failuresInRow: number; pausedReason: string | null;
  businessName: string; contactName: string; email: string; addressText: string;
  lastRun: { runOn: string; outcome: string; reason: string | null; orderNo: string | null } | null;
  lines: { sku: string; title: string; quantity: string }[];
}

const EVERY: Record<string, string> = { weekly: 'Every week', fortnightly: 'Every two weeks', monthly: 'Every month' };

/** Repeat orders set up by trade buyers. Buyers make and change their own; staff can pause, resume or stop one. */
export function StandingOrders() {
  const [status, setStatus] = useState('active');
  const list = useLoad<Row[]>(`/v1/standing-orders?status=${status}`);
  const [error, setError] = useState<unknown>(null);
  const [ok, setOk] = useState('');

  const act = async (r: Row, what: 'pause' | 'resume' | 'cancel') => {
    if (what === 'cancel' && !window.confirm(`Stop ${r.businessName}'s standing order for good?`)) return;
    setError(null); setOk('');
    try { await api(`/v1/standing-orders/${r.id}/${what}`, { method: 'POST' }); setOk(`${r.businessName}: ${what === 'pause' ? 'paused' : what === 'resume' ? 'resumed' : 'cancelled'}.`); list.reload(); } catch (e) { setError(e); }
  };

  return (
    <>
      <PageHeader title="Standing orders" />
      <p className="muted">Each time one comes due, the system places an ordinary order for the buyer at that day's trade prices, subject to stock and credit. After three failures in a row it pauses itself and the buyer is told.</p>
      <label className="field inline"><span className="field-label">Show</span>
        <select value={status} onChange={(e) => setStatus(e.target.value)}><option value="active">Active</option><option value="paused">Paused</option><option value="cancelled">Cancelled</option></select>
      </label>
      <ErrorBanner error={list.error ?? error} />
      {ok && <Notice tone="ok">{ok}</Notice>}
      {list.loading && !list.data ? <Loading what="standing orders" /> : (list.data ?? []).length === 0 && <Notice>None here.</Notice>}
      <ul className="plain">
        {(list.data ?? []).map((r) => (
          <li key={r.id}>
            <article className="panel" aria-label={`Standing order for ${r.businessName}`}>
              <h2>{r.businessName} <span className="chip">{EVERY[r.frequency] ?? r.frequency}</span></h2>
              <p className="muted">{r.contactName} · {r.email} · pays {r.paymentMethod === 'account' ? 'on account' : 'by bank transfer'} · delivers to {r.addressText}</p>
              <p>{r.lines.map((l) => `${l.title} × ${l.quantity}`).join(', ')}</p>
              <p>{r.status === 'active' ? <>Next order: <strong>{r.nextRunOn}</strong></> : <>Next order would be {r.nextRunOn}</>}{r.failuresInRow > 0 ? ` · ${r.failuresInRow} failed in a row` : ''}</p>
              {r.lastRun && <p className="muted small">{r.lastRun.outcome === 'placed' ? `Last order ${r.lastRun.orderNo} on ${r.lastRun.runOn}.` : `Last attempt on ${r.lastRun.runOn} failed: ${r.lastRun.reason}`}</p>}
              {r.status === 'paused' && r.pausedReason && <Notice tone="warn">{r.pausedReason}</Notice>}
              <div className="row-end">
                {r.status === 'active' && <button type="button" className="btn" onClick={() => void act(r, 'pause')}>Pause</button>}
                {r.status === 'paused' && <button type="button" className="btn btn-primary" onClick={() => void act(r, 'resume')}>Resume</button>}
                {r.status !== 'cancelled' && <button type="button" className="btn" onClick={() => void act(r, 'cancel')}>Cancel for good</button>}
              </div>
            </article>
          </li>
        ))}
      </ul>
    </>
  );
}
