import { useRef, useState, type FormEvent } from 'react';
import { ErrorBanner, Field, Loading, Notice } from '../../components/ui';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useLoad } from '../../lib/hooks';
import { today } from './Layout';

interface Rate { id: string; fromCurrency: string; toCurrency: string; rate: string; effectiveDate: string; source: string; status: string; createdBy: string }

/** Exchange rates are shared by every company. A rate counts only after someone other than its author approves it. */
export function Rates() {
  const { can, session } = useAuth();
  const [status, setStatus] = useState('');
  const rates = useLoad<Rate[]>(`/v1/accounting/exchange-rates${status ? `?status=${status}` : ''}`);
  const [error, setError] = useState<unknown>(null);
  const busy = useRef(false);

  async function decide(id: string, action: 'approve' | 'reject') {
    if (busy.current) return;
    busy.current = true; setError(null);
    try { await api(`/v1/accounting/exchange-rates/${id}/${action}`, { method: 'POST', body: {} }); rates.reload(); }
    catch (e) { setError(e); }
    finally { busy.current = false; }
  }
  return (
    <>
      {can('accounting.rates.manage') && <NewRate onDone={rates.reload} />}
      <div className="toolbar">
        <label className="field inline"><span className="field-label">Show</span>
          <select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All</option><option value="pending">Waiting for approval</option><option value="approved">Approved</option><option value="rejected">Rejected</option></select>
        </label>
      </div>
      <ErrorBanner error={rates.error ?? error} />
      {rates.loading && !rates.data ? <Loading what="rates" /> : (
        <div className="table-wrap">
          <table>
            <caption className="sr-only">Exchange rates</caption>
            <thead><tr><th scope="col">Pair</th><th scope="col" className="num">Rate</th><th scope="col">Effective</th><th scope="col">Source</th><th scope="col">Status</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {(rates.data ?? []).map((r) => (
                <tr key={r.id}>
                  <th scope="row">{r.fromCurrency} → {r.toCurrency}</th><td className="num">{r.rate}</td><td>{r.effectiveDate}</td><td>{r.source}</td><td>{r.status}</td>
                  <td>
                    {r.status === 'pending' && can('accounting.rates.approve') && (r.createdBy === session?.user.id
                      ? <span className="muted">Entered by you</span>
                      : <span className="row-end">
                          <button type="button" className="btn btn-primary" onClick={() => decide(r.id, 'approve')} aria-label={`Approve ${r.fromCurrency} to ${r.toCurrency} on ${r.effectiveDate}`}>Approve</button>
                          <button type="button" className="btn btn-ghost" onClick={() => decide(r.id, 'reject')} aria-label={`Reject ${r.fromCurrency} to ${r.toCurrency} on ${r.effectiveDate}`}>Reject</button>
                        </span>)}
                  </td>
                </tr>
              ))}
              {!rates.data?.length && <tr><td colSpan={6} className="muted">No exchange rates.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function NewRate({ onDone }: { onDone(): void }) {
  const [f, setF] = useState({ fromCurrency: '', toCurrency: '', rate: '', effectiveDate: today(), source: '' });
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState(false);
  const ok = /^[A-Z]{3}$/.test(f.fromCurrency) && /^[A-Z]{3}$/.test(f.toCurrency) && f.fromCurrency !== f.toCurrency && /^\d+(\.\d{1,10})?$/.test(f.rate) && Number(f.rate) > 0 && f.source.trim().length >= 2;
  const up = (k: 'fromCurrency' | 'toCurrency') => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value.toUpperCase() });
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null); setDone(false);
    try { await api('/v1/accounting/exchange-rates', { method: 'POST', body: { ...f, source: f.source.trim() } }); setDone(true); setF({ ...f, rate: '' }); onDone(); }
    catch (err) { setError(err); }
  }
  return (
    <details className="panel">
      <summary>Enter a rate</summary>
      <form onSubmit={submit} className="form-grid">
        <Field label="From currency"><input value={f.fromCurrency} maxLength={3} onChange={up('fromCurrency')} /></Field>
        <Field label="To currency"><input value={f.toCurrency} maxLength={3} onChange={up('toCurrency')} /></Field>
        <Field label="Rate" hint="Up to 10 decimals" error={f.rate && !/^\d+(\.\d{1,10})?$/.test(f.rate) ? 'Such as 1550.25' : null}><input inputMode="decimal" value={f.rate} onChange={(e) => setF({ ...f, rate: e.target.value })} /></Field>
        <Field label="Effective date"><input type="date" value={f.effectiveDate} onChange={(e) => setF({ ...f, effectiveDate: e.target.value })} /></Field>
        <Field label="Source" hint="Where the rate comes from"><input value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })} maxLength={200} /></Field>
        <div className="form-actions"><button className="btn btn-primary" disabled={!ok}>Submit for approval</button></div>
      </form>
      <ErrorBanner error={error} />
      {done && <Notice tone="ok">Rate submitted. Someone else must approve it before it is used.</Notice>}
    </details>
  );
}
