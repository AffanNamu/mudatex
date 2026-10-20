import { useRef, useState, type FormEvent } from 'react';
import { ErrorBanner, Field, Loading, Notice } from '../../components/ui';
import { api, newKey } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useLoad } from '../../lib/hooks';
import { useEntity } from './Layout';

interface Period { id: string; name: string; startDate: string; endDate: string; status: string; reopenReason: string | null }

export function Periods() {
  const entity = useEntity();
  const { can } = useAuth();
  const periods = useLoad<Period[]>(`/v1/accounting/periods?legalEntityId=${entity.id}`);
  const [error, setError] = useState<unknown>(null);
  const [reopening, setReopening] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const keys = useRef<Record<string, string>>({});

  async function act(id: string, action: 'close' | 'reopen', body: unknown = {}) {
    setError(null);
    const k = `${action}:${id}`;
    keys.current[k] ??= newKey();
    try { await api(`/v1/accounting/periods/${id}/${action}`, { method: 'POST', body, idempotencyKey: keys.current[k] }); delete keys.current[k]; setReopening(null); setReason(''); periods.reload(); }
    catch (e) { setError(e); }
  }

  return (
    <>
      {can('accounting.manage') && <NewPeriod onDone={periods.reload} />}
      <ErrorBanner error={periods.error ?? error} />
      {periods.loading && !periods.data ? <Loading what="periods" /> : (
        <div className="table-wrap">
          <table>
            <caption className="sr-only">Fiscal periods</caption>
            <thead><tr><th scope="col">Period</th><th scope="col">From</th><th scope="col">To</th><th scope="col">Status</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {(periods.data ?? []).map((p) => (
                <tr key={p.id}>
                  <th scope="row">{p.name}</th><td>{p.startDate}</td><td>{p.endDate}</td>
                  <td>{p.status}{p.reopenReason ? <span className="muted"> · reopened: {p.reopenReason}</span> : null}</td>
                  <td>
                    {p.status === 'open' && can('accounting.period.close') && <button type="button" className="btn btn-ghost" onClick={() => act(p.id, 'close')} aria-label={`Close ${p.name}`}>Close</button>}
                    {p.status === 'closed' && can('accounting.period.reopen') && <button type="button" className="btn btn-ghost" onClick={() => setReopening(p.id)} aria-label={`Reopen ${p.name}`}>Reopen</button>}
                  </td>
                </tr>
              ))}
              {!periods.data?.length && <tr><td colSpan={5} className="muted">No fiscal periods yet. Journals can only be posted into an open period.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      {reopening && (
        <form className="card" onSubmit={(e) => { e.preventDefault(); void act(reopening, 'reopen', { reason: reason.trim() }); }}>
          <h2>Reopen {periods.data?.find((p) => p.id === reopening)?.name}</h2>
          <p className="muted">A different person from the one who closed it must reopen it.</p>
          <Field label="Reason" error={reason && reason.trim().length < 5 ? 'At least 5 characters' : null}><input value={reason} onChange={(e) => { setReason(e.target.value); delete keys.current[`reopen:${reopening}`]; }} maxLength={500} /></Field>
          <div className="row-end">
            <button type="button" className="btn btn-ghost" onClick={() => setReopening(null)}>Cancel</button>
            <button className="btn btn-primary" disabled={reason.trim().length < 5}>Reopen period</button>
          </div>
        </form>
      )}
    </>
  );
}

function NewPeriod({ onDone }: { onDone(): void }) {
  const entity = useEntity();
  const [f, setF] = useState({ name: '', startDate: '', endDate: '' });
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<string | null>(null);
  const ok = f.name.trim() && f.startDate && f.endDate && f.endDate >= f.startDate;
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null); setDone(null);
    try { await api('/v1/accounting/periods', { method: 'POST', body: { legalEntityId: entity.id, name: f.name.trim(), startDate: f.startDate, endDate: f.endDate } }); setDone(f.name.trim()); setF({ name: '', startDate: '', endDate: '' }); onDone(); }
    catch (err) { setError(err); }
  }
  return (
    <details className="panel">
      <summary>New period</summary>
      <form onSubmit={submit} className="form-grid">
        <Field label="Name" hint="For example Jan 2026"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={60} /></Field>
        <Field label="Starts"><input type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} /></Field>
        <Field label="Ends" error={f.endDate && f.startDate && f.endDate < f.startDate ? 'Ends before it starts' : null}><input type="date" value={f.endDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} /></Field>
        <div className="form-actions"><button className="btn btn-primary" disabled={!ok}>Add period</button></div>
      </form>
      <ErrorBanner error={error} />
      {done && <Notice tone="ok">Added “{done}”.</Notice>}
    </details>
  );
}
