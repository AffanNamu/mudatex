import { useState, type FormEvent } from 'react';
import { ErrorBanner, Field, Loading, Notice, PageHeader } from '../components/ui';
import { api } from '../lib/api';
import { useLoad } from '../lib/hooks';
import { formatMoney } from '../lib/money';

interface Account {
  id: string; businessName: string; taxId: string | null; status: 'pending' | 'approved' | 'rejected' | 'suspended'; priceListId: string | null; creditLimitMinor: number; creditUsedMinor: number;
  paymentTermsDays: number; holdAfterDays: number; heldAutomatically: boolean; note: string | null; createdAt: string; storeName: string; currency: string; contactName: string; email: string; phone: string | null;
}
interface PriceList { id: string; name: string; currency: string }

const LABEL = { pending: 'Waiting for a decision', approved: 'Approved', rejected: 'Rejected', suspended: 'On hold' } as const;

/** Wholesale applications and the terms of each approved trade account. */
export function TradeAccounts() {
  const [status, setStatus] = useState('pending');
  const list = useLoad<Account[]>(`/v1/trade-accounts?status=${status}`);
  const lists = useLoad<PriceList[]>('/v1/pricing/price-lists');
  return (
    <>
      <PageHeader title="Trade accounts" />
      <label className="field inline"><span className="field-label">Show</span>
        <select value={status} onChange={(e) => setStatus(e.target.value)}>{Object.entries(LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
      </label>
      <ErrorBanner error={list.error ?? lists.error} />
      {list.loading && !list.data ? <Loading what="trade accounts" /> : (list.data ?? []).length === 0 && <Notice>Nothing here.</Notice>}
      <ul className="plain">{(list.data ?? []).map((a) => <li key={a.id}><Card a={a} lists={lists.data ?? []} onChanged={list.reload} /></li>)}</ul>
    </>
  );
}

function Card({ a, lists, onChanged }: { a: Account; lists: PriceList[]; onChanged(): void }) {
  const eligible = lists.filter((l) => l.currency === a.currency);
  // The price lists may arrive after this card is first drawn, so the default is worked out each time rather than remembered.
  const [chosen, setChosen] = useState(a.priceListId ?? '');
  const listId = chosen || eligible[0]?.id || '';
  const [limit, setLimit] = useState(String(a.creditLimitMinor / 100 || ''));
  const [terms, setTerms] = useState(String(a.paymentTermsDays));
  const [holdDays, setHoldDays] = useState(String(a.holdAfterDays));
  const [note, setNote] = useState(a.note ?? '');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const money = (m: number) => formatMoney(m, a.currency, 2);

  const decide = async (to: Account['status'], e?: FormEvent) => {
    e?.preventDefault();
    setBusy(true); setError(null);
    try {
      await api(`/v1/trade-accounts/${a.id}/decision`, { method: 'POST', body: {
        status: to, ...(to === 'approved' ? { priceListId: listId, creditLimitMinor: Math.round(Number(limit || 0) * 100), paymentTermsDays: Number(terms), holdAfterDays: Number(holdDays) } : {}), ...(note.trim() ? { note: note.trim() } : {}),
      } });
      onChanged();
    } catch (err) { setError(err); } finally { setBusy(false); }
  };

  return (
    <article className="panel" aria-label={`Trade account for ${a.businessName}`}>
      <h2>{a.businessName} <span className="chip">{LABEL[a.status]}</span></h2>
      <p className="muted">{a.contactName} · {a.phone ?? ''} · <a href={`mailto:${a.email}`}>{a.email}</a>{a.taxId ? ` · Tax ID ${a.taxId}` : ''} · applied {new Date(a.createdAt).toLocaleDateString()} · {a.storeName}</p>
      {a.status === 'approved' && <p>Credit {money(a.creditUsedMinor)} used of {money(a.creditLimitMinor)} · {a.paymentTermsDays} day terms.</p>}
      {a.status === 'suspended' && a.heldAutomatically && <Notice tone="warn">Held automatically for late payment. It lifts by itself when the overdue balance is paid, or you can approve it again below. See Collections.</Notice>}
      <form className="form-grid" onSubmit={(e) => decide('approved', e)}>
        <Field label="Trade price list" hint="The shop charges this business the prices on this list."><select value={listId} onChange={(e) => setChosen(e.target.value)}>{eligible.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>
        <Field label={`Credit limit (${a.currency})`}><input inputMode="decimal" value={limit} onChange={(e) => setLimit(e.target.value)} /></Field>
        <Field label="Payment terms (days)"><input type="number" min={0} max={180} value={terms} onChange={(e) => setTerms(e.target.value)} /></Field>
        <Field label="Hold when overdue (days)" hint="The business is put on hold automatically when an invoice is this many days late. 0 turns it off."><input type="number" min={0} max={365} value={holdDays} onChange={(e) => setHoldDays(e.target.value)} /></Field>
        <Field label="Note"><input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} /></Field>
        <div className="form-actions">
          <button className="btn btn-primary" disabled={busy || !listId}>{a.status === 'approved' ? 'Update terms' : 'Approve'}</button>{' '}
          {a.status !== 'approved' && a.status !== 'rejected' && <button type="button" className="btn" disabled={busy} onClick={() => decide('rejected')}>Reject</button>}
          {a.status === 'approved' && <button type="button" className="btn" disabled={busy} onClick={() => decide('suspended')}>Put on hold</button>}
        </div>
      </form>
      {eligible.length === 0 && <Notice tone="warn">Create a trade price list in {a.currency} first (Business setup).</Notice>}
      <ErrorBanner error={error} />
    </article>
  );
}
