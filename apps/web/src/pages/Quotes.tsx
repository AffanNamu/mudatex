import { useMemo, useState, type FormEvent } from 'react';
import { ErrorBanner, Field, Loading, Notice, PageHeader } from '../components/ui';
import { api, newKey } from '../lib/api';
import { useLoad } from '../lib/hooks';
import { formatMoney } from '../lib/money';
import type { Product } from './Catalogue';

interface Row { id: string; quoteNo: string; status: string; currency: string; totalMinor: number; validUntil: string; createdAt: string; businessName: string; orderNo: string | null; lineCount: number }
interface Line { lineNo: number; variantId: string; sku: string; title: string; quantity: string; unitPrice: string; listPrice: string; taxCode: string | null; totalMinor: number }
interface Quote extends Row { note: string | null; minorUnit: number; taxMinor: number; subtotalMinor: number; sentAt: string | null; contactName: string; email: string; lines: Line[] }
interface Account { id: string; businessName: string; currency: string; status: string }
interface Draft { variantId: string; quantity: string; unitPrice: string }

const LABEL: Record<string, string> = { draft: 'Draft', sent: 'Sent, waiting for the buyer', accepted: 'Accepted', declined: 'Declined', cancelled: 'Cancelled', expired: 'Expired' };
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

/** Prices agreed with trade buyers. Staff set the lines and prices; the server works out the tax, rounding and totals. */
export function Quotes() {
  const [status, setStatus] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const list = useLoad<Row[]>(`/v1/quotes${status ? `?status=${status}` : ''}`);
  return (
    <>
      <PageHeader title="Quotes" />
      <p className="muted">A quote fixes prices for a trade buyer until a date. The buyer accepts it in the shop and the order is placed at exactly those prices; nothing is reserved until they accept.</p>
      <ErrorBanner error={list.error} />
      {open ? <Detail id={open} onBack={() => { setOpen(null); list.reload(); }} /> : (
        <>
          <NewQuote onCreated={(id) => { list.reload(); setOpen(id); }} />
          <label className="field inline"><span className="field-label">Show</span>
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All</option>{Object.entries(LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          {list.loading && !list.data ? <Loading what="quotes" /> : (list.data ?? []).length === 0 ? <Notice>No quotes here.</Notice> : (
            <div className="table-wrap">
              <table>
                <caption className="sr-only">Quotes</caption>
                <thead><tr><th scope="col">Quote</th><th scope="col">Business</th><th scope="col">Status</th><th scope="col">Valid until</th><th scope="col" className="num">Goods</th></tr></thead>
                <tbody>{(list.data ?? []).map((q) => (
                  <tr key={q.id}>
                    <th scope="row"><button type="button" className="link" onClick={() => setOpen(q.id)}>{q.quoteNo}</button></th>
                    <td>{q.businessName}</td>
                    <td>{LABEL[q.status] ?? q.status}{q.orderNo ? ` · order ${q.orderNo}` : ''}</td>
                    <td>{q.validUntil}</td>
                    <td className="num">{formatMoney(q.totalMinor, q.currency, 2)}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </>
      )}
    </>
  );
}

function LinesEditor({ lines, setLines, products }: { lines: Draft[]; setLines(l: Draft[]): void; products: Product[] }) {
  const variants = useMemo(() => products.flatMap((p) => p.variants.map((v) => ({ id: v.id, label: `${p.name} (${v.sku})` }))), [products]);
  const set = (i: number, patch: Partial<Draft>) => setLines(lines.map((l, at) => (at === i ? { ...l, ...patch } : l)));
  return (
    <div className="stack">
      {lines.map((l, i) => (
        <div key={i} className="form-grid">
          <Field label={`Product ${i + 1}`}>
            <select value={l.variantId} onChange={(e) => set(i, { variantId: e.target.value })}>
              <option value="">Choose…</option>{variants.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
            </select>
          </Field>
          <Field label={`Quantity ${i + 1}`}><input inputMode="decimal" value={l.quantity} onChange={(e) => set(i, { quantity: e.target.value })} /></Field>
          <Field label={`Agreed price ${i + 1}`} hint="Per unit. Leave empty to use their trade price."><input inputMode="decimal" value={l.unitPrice} onChange={(e) => set(i, { unitPrice: e.target.value })} /></Field>
          {lines.length > 1 && <div className="form-actions"><button type="button" className="btn btn-ghost" onClick={() => setLines(lines.filter((_, at) => at !== i))}>Remove line {i + 1}</button></div>}
        </div>
      ))}
      <div><button type="button" className="btn" onClick={() => setLines([...lines, { variantId: '', quantity: '', unitPrice: '' }])}>Add a line</button></div>
    </div>
  );
}

const toBody = (lines: Draft[]) => lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity.trim(), ...(l.unitPrice.trim() ? { unitPrice: l.unitPrice.trim() } : {}) }));
const valid = (lines: Draft[]) => lines.length > 0 && lines.every((l) => l.variantId && /^\d+(\.\d+)?$/.test(l.quantity.trim()) && Number(l.quantity) > 0 && (!l.unitPrice.trim() || /^\d+(\.\d{1,4})?$/.test(l.unitPrice.trim())));

function NewQuote({ onCreated }: { onCreated(id: string): void }) {
  const accounts = useLoad<Account[]>('/v1/quotes/accounts');
  const products = useLoad<Product[]>('/v1/products?limit=200');
  const [tradeId, setTradeId] = useState('');
  const [until, setUntil] = useState(inDays(14));
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<Draft[]>([{ variantId: '', quantity: '', unitPrice: '' }]);
  const [key, setKey] = useState(newKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const account = tradeId || accounts.data?.[0]?.id || '';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const q = await api<{ id: string }>('/v1/quotes', { method: 'POST', idempotencyKey: key, body: { tradeAccountId: account, validUntil: until, ...(note.trim() ? { note: note.trim() } : {}), lines: toBody(lines) } });
      setKey(newKey()); setLines([{ variantId: '', quantity: '', unitPrice: '' }]); setNote('');
      onCreated(q.id);
    } catch (err) { setError(err); } finally { setBusy(false); }
  };
  return (
    <details className="panel">
      <summary>New quote</summary>
      <form onSubmit={submit} className="stack">
        {accounts.data && accounts.data.length === 0 && <Notice>No business has an approved trade account yet. Approve one under Trade accounts first.</Notice>}
        <div className="form-grid">
          <Field label="Business"><select value={account} onChange={(e) => setTradeId(e.target.value)}>{(accounts.data ?? []).map((a) => <option key={a.id} value={a.id}>{a.businessName}</option>)}</select></Field>
          <Field label="Prices valid until"><input type="date" value={until} min={inDays(0)} max={inDays(90)} onChange={(e) => setUntil(e.target.value)} /></Field>
          <Field label="Note to the buyer (optional)"><input value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} /></Field>
        </div>
        <LinesEditor lines={lines} setLines={(l) => { setLines(l); setKey(newKey()); }} products={products.data ?? []} />
        <ErrorBanner error={error} />
        <div className="form-actions"><button className="btn btn-primary" disabled={busy || !account || !valid(lines)}>{busy ? 'Saving…' : 'Create draft'}</button></div>
      </form>
    </details>
  );
}

function Detail({ id, onBack }: { id: string; onBack(): void }) {
  const q = useLoad<Quote>(`/v1/quotes/${id}`);
  const products = useLoad<Product[]>('/v1/products?limit=200');
  const [editing, setEditing] = useState(false);
  const [lines, setLines] = useState<Draft[]>([]);
  const [note, setNote] = useState('');
  const [until, setUntil] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [ok, setOk] = useState('');
  const data = q.data;

  const act = async (fn: () => Promise<unknown>, message: string) => {
    setBusy(true); setError(null); setOk('');
    try { await fn(); setOk(message); setEditing(false); q.reload(); } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const post = (path: string) => api(`/v1/quotes/${id}/${path}`, { method: 'POST', idempotencyKey: newKey(), body: {} });
  const startEdit = () => {
    if (!data) return;
    setLines(data.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity, unitPrice: l.unitPrice === l.listPrice ? '' : l.unitPrice })));
    setNote(data.note ?? ''); setUntil(data.validUntil); setEditing(true);
  };
  const money = (n: number) => formatMoney(n, data?.currency ?? 'NGN', data?.minorUnit ?? 2);

  return (
    <>
      <button type="button" className="btn btn-ghost" onClick={onBack}>← All quotes</button>
      <ErrorBanner error={q.error ?? error} />
      {ok && <Notice tone="ok">{ok}</Notice>}
      {!data ? <Loading what="the quote" /> : (
        <article className="panel" aria-label={`Quote ${data.quoteNo}`}>
          <h2>{data.quoteNo} <span className="chip">{LABEL[data.status] ?? data.status}</span></h2>
          <p className="muted">{data.businessName} · {data.contactName} · {data.email} · valid until {data.validUntil}{data.orderNo ? ` · became order ${data.orderNo}` : ''}</p>
          {data.note && <p>{data.note}</p>}
          {editing ? (
            <form className="stack" onSubmit={(e) => { e.preventDefault(); void act(() => api(`/v1/quotes/${id}`, { method: 'PUT', idempotencyKey: newKey(), body: { validUntil: until, note: note.trim() || null, lines: toBody(lines) } }), 'Saved.'); }}>
              <div className="form-grid">
                <Field label="Prices valid until"><input type="date" value={until} min={inDays(0)} max={inDays(90)} onChange={(e) => setUntil(e.target.value)} /></Field>
                <Field label="Note to the buyer"><input value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} /></Field>
              </div>
              <LinesEditor lines={lines} setLines={setLines} products={products.data ?? []} />
              <div className="form-actions">
                <button className="btn btn-primary" disabled={busy || !valid(lines)}>Save changes</button>
                <button type="button" className="btn" onClick={() => setEditing(false)}>Cancel</button>
              </div>
            </form>
          ) : (
            <div className="table-wrap">
              <table>
                <caption className="sr-only">Quoted goods</caption>
                <thead><tr><th scope="col">Product</th><th scope="col" className="num">Quantity</th><th scope="col" className="num">Trade price</th><th scope="col" className="num">Agreed price</th><th scope="col" className="num">Total</th></tr></thead>
                <tbody>
                  {data.lines.map((l) => (
                    <tr key={l.lineNo}><th scope="row">{l.title}<div className="muted small">{l.sku}</div></th><td className="num">{l.quantity}</td><td className="num">{l.listPrice}</td>
                      <td className="num">{l.unitPrice === l.listPrice ? '—' : <strong>{l.unitPrice}</strong>}</td><td className="num">{money(l.totalMinor)}</td></tr>
                  ))}
                  <tr><th scope="row" colSpan={4}>Goods, tax included ({money(data.taxMinor)} tax)</th><td className="num"><strong>{money(data.subtotalMinor)}</strong></td></tr>
                </tbody>
              </table>
            </div>
          )}
          {!editing && (
            <div className="row-end">
              {data.status === 'draft' && <button type="button" className="btn" disabled={busy} onClick={startEdit}>Edit</button>}
              {data.status === 'draft' && <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void act(() => post('send'), 'Sent. The buyer has been emailed.')}>Send to the buyer</button>}
              {(data.status === 'draft' || data.status === 'sent') && <button type="button" className="btn" disabled={busy} onClick={() => void act(() => post('cancel'), 'Cancelled.')}>Cancel the quote</button>}
            </div>
          )}
        </article>
      )}
    </>
  );
}
