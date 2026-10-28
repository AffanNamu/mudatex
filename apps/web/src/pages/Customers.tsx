import { useState } from 'react';
import { ErrorBanner, Field, Loading, Notice, PageHeader } from '../components/ui';
import { api } from '../lib/api';
import { useDebounced, useLoad } from '../lib/hooks';
import { formatMoney } from '../lib/money';

interface Row { id: string; fullName: string; email: string; phone: string | null; status: 'active' | 'blocked'; createdAt: string; orders: number; lastOrderAt: string | null; isTrade: boolean }
interface Detail {
  id: string; fullName: string; email: string; phone: string | null; status: 'active' | 'blocked'; marketingOptIn: boolean; smsOptIn: boolean; language: string; blockedReason: string | null; blockedAt: string | null; createdAt: string; reviews: number;
  addresses: { label: string; recipient: string; phone: string; line1: string; line2: string | null; city: string; state: string; countryCode: string; isDefault: boolean }[];
  orders: { id: string; orderNo: string; status: string; currency: string; totalMinor: number; paidMinor: number; paymentMethod: string; placedAt: string; minorUnit: number }[];
  tradeAccounts: { businessName: string; taxId: string | null; status: string; creditLimitMinor: number; paymentTermsDays: number }[];
}

/** Look up an online shopper: who they are, what they bought, and block or unblock their account. */
export function Customers() {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const dq = useDebounced(q, 300);
  const params = new URLSearchParams({ limit: '50' });
  if (dq.trim()) params.set('q', dq.trim());
  if (status) params.set('status', status);
  const list = useLoad<{ total: number; items: Row[] }>(`/v1/customers?${params}`);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      <PageHeader title="Customers" />
      <p className="muted">Shoppers who have an account on the online store. Their details are private: look at them only to help the customer.</p>
      <div className="toolbar">
        <label className="field inline"><span className="field-label">Search</span><input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, email or phone" /></label>
        <label className="field inline"><span className="field-label">Show</span>
          <select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Everyone</option><option value="active">Active</option><option value="blocked">Blocked</option></select></label>
      </div>
      <ErrorBanner error={list.error} />
      {list.loading && !list.data ? <Loading what="customers" /> : (
        <div className="table-wrap"><table>
          <caption className="sr-only">Customers</caption>
          <thead><tr><th scope="col">Name</th><th scope="col">Email</th><th scope="col">Phone</th><th scope="col">Orders</th><th scope="col">Last order</th><th scope="col">Status</th></tr></thead>
          <tbody>
            {(list.data?.items ?? []).map((c) => (
              <tr key={c.id}>
                <th scope="row"><button className="btn btn-ghost" aria-expanded={open === c.id} onClick={() => setOpen(open === c.id ? null : c.id)}>{c.fullName}</button>{c.isTrade && <span className="chip">Trade</span>}</th>
                <td>{c.email}</td><td>{c.phone ?? '—'}</td><td>{c.orders}</td><td>{c.lastOrderAt ? new Date(c.lastOrderAt).toLocaleDateString() : '—'}</td><td>{c.status === 'blocked' ? 'Blocked' : 'Active'}</td>
              </tr>
            ))}
            {list.data?.items.length === 0 && <tr><td colSpan={6} className="muted">No customers{q || status ? ' match' : ' yet'}.</td></tr>}
          </tbody>
        </table></div>
      )}
      {list.data && list.data.total > list.data.items.length && <p className="muted">Showing {list.data.items.length} of {list.data.total}. Search to narrow it down.</p>}
      {open && <CustomerPanel key={open} id={open} onChanged={list.reload} />}
    </>
  );
}

function CustomerPanel({ id, onChanged }: { id: string; onChanged(): void }) {
  const d = useLoad<Detail>(`/v1/customers/${id}`);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const c = d.data;
  if (!c) return <><ErrorBanner error={d.error} />{d.loading && <Loading what="the customer" />}</>;
  const act = async (what: 'block' | 'unblock') => {
    setBusy(true); setError(null);
    try { await api(`/v1/customers/${id}/${what}`, { method: 'POST', body: what === 'block' ? { reason: reason.trim() } : {} }); setReason(''); d.reload(); onChanged(); } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const download = async () => {
    setError(null);
    try {
      const data = await api<unknown>(`/v1/customers/${id}/export`);
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a'); a.href = url; a.download = `customer-${c.id}.json`; a.click(); URL.revokeObjectURL(url);
    } catch (e) { setError(e); }
  };
  return (
    <section className="panel" aria-label={`Customer ${c.fullName}`}>
      <h2>{c.fullName} <span className="chip">{c.status === 'blocked' ? 'Blocked' : 'Active'}</span></h2>
      <p>{c.email} · {c.phone ?? 'no phone'} · language {c.language} · joined {new Date(c.createdAt).toLocaleDateString()} · {c.reviews} review{c.reviews === 1 ? '' : 's'}<br />
        Emails about offers: {c.marketingOptIn ? 'yes' : 'no'} · texts about orders: {c.smsOptIn ? 'yes' : 'no'}</p>
      {c.tradeAccounts.map((t) => <p key={t.businessName}><strong>Trade account:</strong> {t.businessName} ({t.status}), {t.paymentTermsDays}-day terms{t.taxId ? `, tax ID ${t.taxId}` : ''}</p>)}
      {c.status === 'blocked' && <Notice tone="warn">Blocked{c.blockedAt ? ` on ${new Date(c.blockedAt).toLocaleDateString()}` : ''}: {c.blockedReason}</Notice>}
      <h3>Addresses</h3>
      <ul className="plain">{c.addresses.map((a, i) => <li key={i}>{a.label}{a.isDefault ? ' (default)' : ''}: {a.recipient}, {a.line1}{a.line2 ? `, ${a.line2}` : ''}, {a.city}, {a.state} {a.countryCode} · {a.phone}</li>)}{c.addresses.length === 0 && <li className="muted">None saved.</li>}</ul>
      <h3>Orders</h3>
      <ul className="plain">{c.orders.map((o) => <li key={o.id}>{o.orderNo} · {new Date(o.placedAt).toLocaleDateString()} · {o.status.replace('_', ' ')} · {formatMoney(o.totalMinor, o.currency, o.minorUnit)}{o.paidMinor ? ` (paid ${formatMoney(o.paidMinor, o.currency, o.minorUnit)})` : ''}</li>)}{c.orders.length === 0 && <li className="muted">No orders.</li>}</ul>
      <ErrorBanner error={error} />
      <div className="form-grid">
        {c.status === 'active' ? (
          <>
            <Field label="Reason for blocking" hint="Kept on record. A blocked customer cannot sign in to the shop or order."><input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} /></Field>
            <div className="form-actions"><button className="btn" disabled={busy || reason.trim().length < 3} onClick={() => void act('block')}>Block this account</button></div>
          </>
        ) : <div className="form-actions"><button className="btn btn-primary" disabled={busy} onClick={() => void act('unblock')}>Lift the block</button></div>}
        <div className="form-actions"><button className="btn" onClick={() => void download()}>Download everything held about them</button></div>
      </div>
    </section>
  );
}
