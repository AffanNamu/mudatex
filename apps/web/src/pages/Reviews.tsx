import { useState } from 'react';
import { ErrorBanner, Loading, Notice, PageHeader } from '../components/ui';
import { api } from '../lib/api';
import { useLoad } from '../lib/hooks';

interface Review { id: string; rating: number; title: string | null; body: string; name: string; status: string; createdAt: string; productTitle: string; storeName: string }

/** Reviews are read by a person before the public sees them. */
export function Reviews() {
  const [status, setStatus] = useState('pending');
  const list = useLoad<Review[]>(`/v1/reviews?status=${status}&limit=100`);
  const [error, setError] = useState<unknown>(null);
  const decide = async (id: string, to: 'published' | 'rejected') => {
    setError(null);
    try { await api(`/v1/reviews/${id}/moderate`, { method: 'POST', body: { status: to } }); list.reload(); } catch (e) { setError(e); }
  };
  return (
    <>
      <PageHeader title="Product reviews" />
      <label className="field inline"><span className="field-label">Show</span>
        <select value={status} onChange={(e) => setStatus(e.target.value)}><option value="pending">Waiting for approval</option><option value="published">Published</option><option value="rejected">Rejected</option></select>
      </label>
      <ErrorBanner error={list.error ?? error} />
      {list.loading && !list.data ? <Loading what="reviews" /> : (list.data ?? []).length === 0 && <Notice>Nothing here.</Notice>}
      <ul className="plain">
        {(list.data ?? []).map((r) => (
          <li key={r.id}><article className="panel" aria-label={`Review of ${r.productTitle} by ${r.name}`}>
            <h2>{r.productTitle} <span className="chip">{'★'.repeat(r.rating)}{'☆'.repeat(5 - r.rating)} {r.rating}/5</span></h2>
            {r.title && <p><strong>{r.title}</strong></p>}
            <p style={{ whiteSpace: 'pre-line' }}>{r.body}</p>
            <p className="muted">{r.name} · {new Date(r.createdAt).toLocaleDateString()} · {r.storeName}</p>
            <div className="row">
              {r.status !== 'published' && <button className="btn btn-primary" onClick={() => decide(r.id, 'published')}>Publish</button>}
              {r.status !== 'rejected' && <button className="btn" onClick={() => decide(r.id, 'rejected')}>Reject</button>}
            </div>
          </article></li>
        ))}
      </ul>
    </>
  );
}
