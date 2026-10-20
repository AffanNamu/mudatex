import { useState, type FormEvent } from 'react';
import { ErrorBanner, Field, Loading, Notice } from '../../components/ui';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useLoad } from '../../lib/hooks';
import { useEntity } from './Layout';

export interface Account { id: string; code: string; name: string; type: string; parentId: string | null; isPostable: boolean; currency: string | null; status: string }
const TYPES = ['asset', 'liability', 'equity', 'revenue', 'expense'] as const;

export function Accounts() {
  const entity = useEntity();
  const { can } = useAuth();
  const accounts = useLoad<Account[]>(`/v1/accounting/accounts?legalEntityId=${entity.id}`);
  const [error, setError] = useState<unknown>(null);

  async function archive(a: Account) {
    setError(null);
    try { await api(`/v1/accounting/accounts/${a.id}/archive`, { method: 'POST', body: {} }); accounts.reload(); }
    catch (e) { setError(e); }
  }
  const byId = new Map((accounts.data ?? []).map((a) => [a.id, a]));
  return (
    <>
      {can('accounting.manage') && <NewAccount accounts={accounts.data ?? []} onDone={accounts.reload} />}
      <ErrorBanner error={accounts.error ?? error} />
      {accounts.loading && !accounts.data ? <Loading what="accounts" /> : (
        <div className="table-wrap">
          <table>
            <caption className="sr-only">Chart of accounts</caption>
            <thead><tr><th scope="col">Code</th><th scope="col">Name</th><th scope="col">Type</th><th scope="col">Kind</th><th scope="col">Status</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {(accounts.data ?? []).map((a) => (
                <tr key={a.id}>
                  <th scope="row">{a.code}</th>
                  <td>{a.parentId && '↳ '}{a.name}{a.currency ? ` (${a.currency} only)` : ''}{a.parentId && byId.get(a.parentId) ? <span className="muted"> under {byId.get(a.parentId)!.code}</span> : null}</td>
                  <td>{a.type}</td><td>{a.isPostable ? 'Postable' : 'Header'}</td><td>{a.status}</td>
                  <td>{can('accounting.manage') && a.status === 'active' && <button type="button" className="btn btn-ghost" onClick={() => archive(a)} aria-label={`Archive ${a.code}`}>Archive</button>}</td>
                </tr>
              ))}
              {!accounts.data?.length && <tr><td colSpan={6} className="muted">No accounts yet. The chart of accounts is a finance decision; add accounts once it is agreed.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function NewAccount({ accounts, onDone }: { accounts: Account[]; onDone(): void }) {
  const entity = useEntity();
  const [f, setF] = useState({ code: '', name: '', type: 'asset', parentId: '', isPostable: true, currency: '' });
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<string | null>(null);
  const headers = accounts.filter((a) => !a.isPostable && a.type === f.type && a.status === 'active');
  const valid = /^[0-9A-Za-z.-]{1,20}$/.test(f.code) && f.name.trim() && (!f.currency || (f.isPostable && /^[A-Z]{3}$/.test(f.currency)));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null); setDone(null);
    try {
      await api('/v1/accounting/accounts', { method: 'POST', body: {
        legalEntityId: entity.id, code: f.code, name: f.name.trim(), type: f.type, isPostable: f.isPostable,
        ...(f.parentId ? { parentId: f.parentId } : {}), ...(f.currency ? { currency: f.currency } : {}),
      } });
      setDone(`${f.code} ${f.name.trim()}`); setF({ ...f, code: '', name: '' }); onDone();
    } catch (err) { setError(err); }
  }
  return (
    <details className="panel">
      <summary>New account</summary>
      <form onSubmit={submit} className="form-grid">
        <Field label="Code" hint="Letters, digits, . or -" error={f.code && !/^[0-9A-Za-z.-]{1,20}$/.test(f.code) ? 'Up to 20 letters, digits, . or -' : null}><input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} /></Field>
        <Field label="Account name"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={200} /></Field>
        <Field label="Type"><select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value, parentId: '' })}>{TYPES.map((t) => <option key={t}>{t}</option>)}</select></Field>
        <Field label="Under header (optional)"><select value={f.parentId} onChange={(e) => setF({ ...f, parentId: e.target.value })}><option value="">None</option>{headers.map((h) => <option key={h.id} value={h.id}>{h.code} {h.name}</option>)}</select></Field>
        <Field label="Currency restriction (optional)" hint="Three letters, for bank accounts held in one currency"><input value={f.currency} maxLength={3} onChange={(e) => setF({ ...f, currency: e.target.value.toUpperCase() })} /></Field>
        <label className="field"><span className="field-label">Postings</span><span><input type="checkbox" checked={f.isPostable} onChange={(e) => setF({ ...f, isPostable: e.target.checked, currency: e.target.checked ? f.currency : '' })} /> Journals can post here (untick for a header)</span></label>
        <div className="form-actions"><button className="btn btn-primary" disabled={!valid}>Add account</button></div>
      </form>
      <ErrorBanner error={error} />
      {done && <Notice tone="ok">Added {done}.</Notice>}
    </details>
  );
}
