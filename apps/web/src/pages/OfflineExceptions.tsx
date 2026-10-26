import { useState } from 'react';
import { ErrorBanner, Field, Loading, Notice, PageHeader } from '../components/ui';
import { api } from '../lib/api';
import { useLoad } from '../lib/hooks';

interface Row { id: string; quantityShort: string; sku: string; productName: string; locationName: string; receiptNumber: string; offlineReceiptNo: string | null; soldAt: string; status: string; note: string | null }

/** Goods sold offline that the books did not cover when the sale arrived. A person explains each one (ADR 002). */
export function OfflineExceptions() {
  const [status, setStatus] = useState('open');
  const list = useLoad<Row[]>(`/v1/pos/offline-exceptions?status=${status}`);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const resolve = async (id: string) => {
    setError(null);
    try { await api(`/v1/pos/offline-exceptions/${id}/resolve`, { method: 'POST', body: { note: notes[id] ?? '' } }); list.reload(); } catch (e) { setError(e); }
  };
  return (
    <>
      <PageHeader title="Offline stock exceptions" />
      <p className="muted">When a till sells offline, the goods have already left the shop. If the books showed less than was sold, the sale stands and the shortfall is listed here. Find out why (a late receipt, a counting error), correct the stock, then record what you found.</p>
      <label className="field inline"><span className="field-label">Show</span>
        <select value={status} onChange={(e) => setStatus(e.target.value)}><option value="open">Open</option><option value="resolved">Resolved</option></select>
      </label>
      <ErrorBanner error={list.error ?? error} />
      {list.loading && !list.data ? <Loading what="exceptions" /> : (list.data ?? []).length === 0 && <Notice>Nothing here.</Notice>}
      <ul className="plain">
        {(list.data ?? []).map((x) => (
          <li key={x.id}><article className="panel" aria-label={`Shortfall of ${x.productName}`}>
            <h2>{x.productName} <span className="chip">{x.quantityShort} short</span></h2>
            <p className="muted">{x.sku} · {x.locationName} · sale {x.receiptNumber}{x.offlineReceiptNo ? ` (till receipt ${x.offlineReceiptNo})` : ''} · sold {new Date(x.soldAt).toLocaleString()}</p>
            {x.status === 'open' ? (
              <form className="form-grid" onSubmit={(e) => { e.preventDefault(); resolve(x.id); }}>
                <Field label="What was found"><input required minLength={5} maxLength={500} value={notes[x.id] ?? ''} onChange={(e) => setNotes({ ...notes, [x.id]: e.target.value })} /></Field>
                <div className="form-actions"><button className="btn btn-primary" disabled={(notes[x.id] ?? '').trim().length < 5}>Mark as explained</button></div>
              </form>
            ) : <p>{x.note}</p>}
          </article></li>
        ))}
      </ul>
    </>
  );
}
