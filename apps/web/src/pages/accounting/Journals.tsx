import { useMemo, useRef, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ErrorBanner, Field, Loading, Notice } from '../../components/ui';
import { api, newKey } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useLoad } from '../../lib/hooks';
import { formatMoney, parseMoney } from '../../lib/money';
import type { Account } from './Accounts';
import { today, useEntity } from './Layout';

interface Row { id: string; journalNumber: string | null; postingDate: string; description: string; status: string; currency: string; createdBy: string; sourceType: string | null; totalMinor: number }
interface Line { lineNo: number; accountCode: string; accountName: string; debitMinor: number; creditMinor: number; description: string | null }
interface Journal extends Row { lines: Line[]; reversesEntryId: string | null; reversedByEntryId: string | null; exchangeRate: string | null }

export function Journals() {
  const entity = useEntity();
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const selected = params.get('j');
  const [status, setStatus] = useState('');
  const list = useLoad<Row[]>(`/v1/accounting/journals?legalEntityId=${entity.id}&limit=100${status ? `&status=${status}` : ''}`);
  const open = (id: string | null) => setParams(id ? { j: id } : {});

  if (selected) return <JournalView id={selected} onBack={() => { list.reload(); open(null); }} onOpen={(id) => { list.reload(); open(id); }} />;
  return (
    <>
      {can('accounting.journal') && <NewJournal onCreated={(id) => { list.reload(); open(id); }} />}
      <div className="toolbar">
        <label className="field inline"><span className="field-label">Show</span>
          <select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All</option><option value="draft">Drafts</option><option value="posted">Posted</option></select>
        </label>
      </div>
      <ErrorBanner error={list.error} />
      {list.loading && !list.data ? <Loading what="journals" /> : (
        <div className="table-wrap">
          <table>
            <caption className="sr-only">Journals</caption>
            <thead><tr><th scope="col">Number</th><th scope="col">Date</th><th scope="col">Description</th><th scope="col">Status</th><th scope="col" className="num">Amount</th></tr></thead>
            <tbody>
              {(list.data ?? []).map((j) => (
                <tr key={j.id}>
                  <th scope="row"><button type="button" className="link" onClick={() => open(j.id)}>{j.journalNumber ?? 'Draft'}</button></th>
                  <td>{j.postingDate}</td><td>{j.description}</td><td>{j.status}</td>
                  <td className="num">{formatMoney(j.totalMinor, j.currency, entity.minorUnit)}</td>
                </tr>
              ))}
              {!list.data?.length && <tr><td colSpan={5} className="muted">No journals.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

interface Draft { accountId: string; debit: string; credit: string; description: string }
const blank = (): Draft => ({ accountId: '', debit: '', credit: '', description: '' });

function NewJournal({ onCreated }: { onCreated(id: string): void }) {
  const entity = useEntity();
  const accounts = useLoad<Account[]>(`/v1/accounting/accounts?legalEntityId=${entity.id}`);
  const postable = useMemo(() => (accounts.data ?? []).filter((a) => a.isPostable && a.status === 'active'), [accounts.data]);
  const [date, setDate] = useState(today());
  const [description, setDescription] = useState('');
  const [lines, setLines] = useState<Draft[]>([blank(), blank()]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const key = useRef(newKey());
  const touch = () => { key.current = newKey(); };
  const edit = (i: number, patch: Partial<Draft>) => { setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l))); touch(); };

  // Entered amounts as whole minor units. Anything unreadable is null; the server checks everything again.
  const parsed = lines.map((l) => ({
    ...l,
    accountId: l.accountId || postable[0]?.id || '',
    d: l.debit.trim() ? parseMoney(l.debit, entity.minorUnit) : 0,
    c: l.credit.trim() ? parseMoney(l.credit, entity.minorUnit) : 0,
  }));
  const readable = parsed.every((l) => l.d !== null && l.c !== null);
  const eachOneSided = parsed.every((l) => ((l.d ?? 0) > 0) !== ((l.c ?? 0) > 0));
  const debits = parsed.reduce((a, l) => a + (l.d ?? 0), 0);
  const credits = parsed.reduce((a, l) => a + (l.c ?? 0), 0);
  const balanced = readable && eachOneSided && debits === credits && debits > 0;
  const fmt = (m: number) => formatMoney(m, entity.functionalCurrency, entity.minorUnit);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!balanced || description.trim().length < 3) return;
    setBusy(true); setError(null);
    try {
      const j = await api<{ id: string }>('/v1/accounting/journals', {
        method: 'POST', idempotencyKey: key.current,
        body: {
          legalEntityId: entity.id, postingDate: date, description: description.trim(),
          lines: parsed.map((l) => ({ accountId: l.accountId, debitMinor: l.d ?? 0, creditMinor: l.c ?? 0, ...(l.description.trim() ? { description: l.description.trim() } : {}) })),
        },
      });
      onCreated(j.id);
    } catch (err) { setError(err); setBusy(false); }
  }

  return (
    <details className="panel">
      <summary>New journal</summary>
      {!postable.length && !accounts.loading && <Notice>Add postable accounts to the chart of accounts first.</Notice>}
      <form onSubmit={submit}>
        <div className="form-grid">
          <Field label="Posting date"><input type="date" value={date} onChange={(e) => { setDate(e.target.value); touch(); }} required /></Field>
          <Field label="Description"><input value={description} onChange={(e) => { setDescription(e.target.value); touch(); }} maxLength={500} /></Field>
        </div>
        <fieldset className="payment">
          <legend>Lines</legend>
          {parsed.map((l, i) => (
            <div key={i} className="form-grid">
              <Field label={`Account ${i + 1}`}><select value={l.accountId} onChange={(e) => edit(i, { accountId: e.target.value })}>{postable.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}</select></Field>
              <Field label={`Debit ${i + 1}`} error={l.d === null ? 'Such as 1,250.00' : null}><input inputMode="decimal" value={lines[i]!.debit} onChange={(e) => edit(i, { debit: e.target.value })} /></Field>
              <Field label={`Credit ${i + 1}`} error={l.c === null ? 'Such as 1,250.00' : null}><input inputMode="decimal" value={lines[i]!.credit} onChange={(e) => edit(i, { credit: e.target.value })} /></Field>
              <Field label={`Note ${i + 1}`}><input value={lines[i]!.description} onChange={(e) => edit(i, { description: e.target.value })} maxLength={300} /></Field>
              {parsed.length > 2 && <div className="form-actions"><button type="button" className="btn btn-ghost" onClick={() => { setLines(lines.filter((_, j) => j !== i)); touch(); }}>Remove line {i + 1}</button></div>}
            </div>
          ))}
          <button type="button" className="btn btn-ghost" onClick={() => { setLines([...lines, blank()]); touch(); }}>Add a line</button>
          <p role="status" className={balanced ? 'muted' : 'bad'}>
            Debits {fmt(debits)} · credits {fmt(credits)}{debits !== credits ? ` · out by ${fmt(Math.abs(debits - credits))}` : balanced ? ' · balanced' : ''}
            {readable && !eachOneSided ? ' · each line needs a debit or a credit, not both' : ''}
          </p>
        </fieldset>
        <ErrorBanner error={error} />
        <button className="btn btn-primary" disabled={busy || !balanced || description.trim().length < 3}>{busy ? 'Saving…' : 'Save as draft'}</button>
      </form>
    </details>
  );
}

function JournalView({ id, onBack, onOpen }: { id: string; onBack(): void; onOpen(id: string): void }) {
  const entity = useEntity();
  const { can, session } = useAuth();
  const j = useLoad<Journal>(`/v1/accounting/journals/${id}`);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [revDate, setRevDate] = useState(today());
  const [reason, setReason] = useState('');
  const keys = useRef<Record<string, string>>({});
  const o = j.data;

  async function act(name: string, path: string, body: unknown = {}) {
    setBusy(true); setError(null);
    keys.current[name] ??= newKey();
    try {
      const r = await api<{ id: string }>(path, { method: 'POST', body, idempotencyKey: keys.current[name] });
      delete keys.current[name];
      if (name === 'reverse') { onOpen(r.id); return; }
      j.reload();
    } catch (e) { setError(e); }
    finally { setBusy(false); }
  }
  async function remove() {
    setBusy(true); setError(null);
    try { await api(`/v1/accounting/journals/${id}`, { method: 'DELETE' }); onBack(); }
    catch (e) { setError(e); setBusy(false); }
  }

  if (!o) return <><button type="button" className="btn btn-ghost" onClick={onBack}>← All journals</button><ErrorBanner error={j.error} />{j.loading && <Loading what="journal" />}</>;
  const fmt = (m: number | null) => formatMoney(m ?? 0, o.currency, entity.minorUnit);
  const mine = o.createdBy === session?.user.id;
  const debits = o.lines.reduce((a, l) => a + (l.debitMinor ?? 0), 0);
  const credits = o.lines.reduce((a, l) => a + (l.creditMinor ?? 0), 0);

  return (
    <>
      <button type="button" className="btn btn-ghost" onClick={onBack}>← All journals</button>
      <section className="card" aria-label={`Journal ${o.journalNumber ?? 'draft'}`}>
        <h2>{o.journalNumber ?? 'Draft journal'} · {o.status}</h2>
        <p className="muted">{o.postingDate} · {o.description}{o.exchangeRate ? ` · rate ${o.exchangeRate}` : ''}</p>
        {o.reversedByEntryId && <Notice tone="warn">This journal has been reversed.</Notice>}
        {o.reversesEntryId && <Notice>This journal reverses an earlier one.</Notice>}
        <div className="table-wrap">
          <table>
            <thead><tr><th scope="col">Account</th><th scope="col">Note</th><th scope="col" className="num">Debit</th><th scope="col" className="num">Credit</th></tr></thead>
            <tbody>{o.lines.map((l) => (
              <tr key={l.lineNo}><th scope="row">{l.accountCode} {l.accountName}</th><td>{l.description ?? ''}</td>
                <td className="num">{l.debitMinor ? fmt(l.debitMinor) : ''}</td><td className="num">{l.creditMinor ? fmt(l.creditMinor) : ''}</td></tr>
            ))}</tbody>
            <tfoot><tr><th scope="row" colSpan={2}>Total</th><td className="num"><strong>{fmt(debits)}</strong></td><td className="num"><strong>{fmt(credits)}</strong></td></tr></tfoot>
          </table>
        </div>
        <ErrorBanner error={error} />
        {o.status === 'draft' && (
          <>
            {mine && can('accounting.post') && <Notice tone="warn">You created this journal, so someone else must post it.</Notice>}
            <div className="row-end">
              {can('accounting.journal') && <button type="button" className="btn btn-ghost" disabled={busy} onClick={remove}>Delete draft</button>}
              {can('accounting.post') && <button type="button" className="btn btn-primary" disabled={busy} onClick={() => act('post', `/v1/accounting/journals/${id}/post`)}>Post journal</button>}
            </div>
          </>
        )}
        {o.status === 'posted' && !o.reversedByEntryId && can('accounting.journal') && (
          <form className="payment" onSubmit={(e) => { e.preventDefault(); void act('reverse', `/v1/accounting/journals/${id}/reverse`, { postingDate: revDate, reason: reason.trim() }); }}>
            <h3>Reverse this journal</h3>
            <p className="muted">Creates a draft with debits and credits swapped. Someone else posts it.</p>
            <div className="form-grid">
              <Field label="Reversal date"><input type="date" value={revDate} onChange={(e) => { setRevDate(e.target.value); delete keys.current.reverse; }} required /></Field>
              <Field label="Reason" error={reason && reason.trim().length < 5 ? 'At least 5 characters' : null}><input value={reason} onChange={(e) => { setReason(e.target.value); delete keys.current.reverse; }} maxLength={500} /></Field>
            </div>
            <button className="btn btn-ghost" disabled={busy || reason.trim().length < 5}>Create reversal draft</button>
          </form>
        )}
      </section>
    </>
  );
}
