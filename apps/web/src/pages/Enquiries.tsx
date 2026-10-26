import { useState } from 'react';
import { ErrorBanner, Loading, Notice, PageHeader } from '../components/ui';
import { api } from '../lib/api';
import { useLoad } from '../lib/hooks';

interface Enquiry { id: string; kind: string; name: string; email: string | null; phone: string | null; company: string | null; message: string; status: 'new' | 'in_progress' | 'closed'; note: string | null; createdAt: string; storeName: string }

const KIND: Record<string, string> = { contact: 'Question', wholesale: 'Wholesale', custom_order: 'Made to order', careers: 'Job enquiry' };
const STATUS = [['new', 'New'], ['in_progress', 'Being handled'], ['closed', 'Closed']] as const;

/** Messages from the public website, to be answered by a person. */
export function Enquiries() {
  const [status, setStatus] = useState('new');
  const list = useLoad<Enquiry[]>(`/v1/enquiries?status=${status}&limit=100`);
  return (
    <>
      <PageHeader title="Website enquiries" />
      <label className="field inline"><span className="field-label">Show</span>
        <select value={status} onChange={(e) => setStatus(e.target.value)}>{STATUS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
      </label>
      <ErrorBanner error={list.error} />
      {list.loading && !list.data ? <Loading what="enquiries" /> : (list.data ?? []).length === 0 && <Notice>Nothing here.</Notice>}
      <ul className="plain">{(list.data ?? []).map((q) => <li key={q.id}><Card q={q} onChanged={list.reload} /></li>)}</ul>
    </>
  );
}

function Card({ q, onChanged }: { q: Enquiry; onChanged(): void }) {
  const [note, setNote] = useState(q.note ?? '');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const move = async (status: Enquiry['status']) => {
    setBusy(true); setError(null);
    try { await api(`/v1/enquiries/${q.id}/status`, { method: 'POST', body: { status, ...(note.trim() ? { note: note.trim() } : {}) } }); onChanged(); }
    catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <article className="panel" aria-label={`Enquiry from ${q.name}`}>
      <h2>{q.name}{q.company ? ` — ${q.company}` : ''} <span className="chip">{KIND[q.kind] ?? q.kind}</span></h2>
      <p className="muted">{new Date(q.createdAt).toLocaleString()} · {q.phone ?? ''} {q.email ? <a href={`mailto:${q.email}`}>{q.email}</a> : null}</p>
      <p style={{ whiteSpace: 'pre-line' }}>{q.message}</p>
      <label className="field"><span className="field-label">Note for the team</span><input value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} /></label>
      <ErrorBanner error={error} />
      <div className="row">
        {q.status !== 'in_progress' && <button className="btn" disabled={busy} onClick={() => move('in_progress')}>I am handling this</button>}
        {q.status !== 'closed' && <button className="btn btn-primary" disabled={busy} onClick={() => move('closed')}>Close</button>}
        {q.status === 'closed' && <button className="btn" disabled={busy} onClick={() => move('new')}>Reopen</button>}
      </div>
    </article>
  );
}
