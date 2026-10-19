import { useMemo, useRef, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ErrorBanner, Field, Loading, Notice, PageHeader } from '../components/ui';
import { api, newKey } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useLoad } from '../lib/hooks';
import { formatMoney, parseQuantity } from '../lib/money';
import type { Product } from './Catalogue';

interface Supplier { id: string; code: string; name: string; status: string; defaultCurrency: string }
interface Location { id: string; name: string; type: string }
interface Row { id: string; poNumber: string; status: string; supplierName: string; destinationName: string; currency: string; minorUnit: number; totalMinor: number }
interface Line { id: string; lineNo: number; variantId: string; sku: string; productName: string; tracking: 'none' | 'lot' | 'roll'; quantity: string; unitPrice: string; totalMinor: number; receivedQuantity: string; outstandingQuantity: string }
interface Po extends Row {
  createdBy: string; decisionNote: string | null; note: string | null; lines: Line[];
  receipts: { id: string; receiptNumber: string; deliveryNote: string | null }[];
}

const STATUS: Record<string, string> = {
  draft: 'Draft', pending_approval: 'Awaiting approval', approved: 'Approved', partially_received: 'Partly received',
  received: 'Received', closed: 'Closed', cancelled: 'Cancelled',
};
const HOLDS_STOCK = new Set(['branch', 'warehouse', 'storage_location']);
const PRICE = /^\d+(\.\d{1,4})?$/;

export function Procurement() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const selected = params.get('po');
  const list = useLoad<Row[]>('/v1/procurement/purchase-orders?limit=100');
  const open = (id: string | null) => setParams(id ? { po: id } : {});

  return (
    <>
      <PageHeader title="Purchasing" />
      <ErrorBanner error={list.error} />
      {can('procurement.create') && !selected && <NewOrder onCreated={(id) => { list.reload(); open(id); }} />}
      {can('procurement.supplier.manage') && !selected && <NewSupplier />}
      {selected ? (
        <Order key={selected} id={selected} onBack={() => { list.reload(); open(null); }} onChanged={list.reload} />
      ) : list.loading && !list.data ? <Loading what="orders" /> : (
        <div className="table-wrap">
          <table>
            <caption className="sr-only">Purchase orders</caption>
            <thead><tr><th scope="col">Order</th><th scope="col">Supplier</th><th scope="col">Deliver to</th><th scope="col">Status</th><th scope="col" className="num">Total</th></tr></thead>
            <tbody>
              {(list.data ?? []).map((o) => (
                <tr key={o.id}>
                  <th scope="row"><button type="button" className="link" onClick={() => open(o.id)}>{o.poNumber}</button></th>
                  <td>{o.supplierName}</td><td>{o.destinationName}</td><td>{STATUS[o.status] ?? o.status}</td>
                  <td className="num">{formatMoney(o.totalMinor, o.currency, o.minorUnit)}</td>
                </tr>
              ))}
              {!list.data?.length && <tr><td colSpan={5} className="muted">No purchase orders yet.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function NewSupplier() {
  const suppliers = useLoad<Supplier[]>('/v1/procurement/suppliers');
  const [f, setF] = useState({ code: '', name: '', countryCode: '', defaultCurrency: '', paymentTermsDays: '30' });
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const days = /^\d{1,3}$/.test(f.paymentTermsDays) ? Number(f.paymentTermsDays) : null;
  const ok = /^[A-Z0-9_-]{2,20}$/.test(f.code) && f.name.trim() && /^[A-Z]{2}$/.test(f.countryCode) && /^[A-Z]{3}$/.test(f.defaultCurrency) && days !== null && days <= 365;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null); setDone(null);
    try {
      await api('/v1/procurement/suppliers', { method: 'POST', body: { ...f, name: f.name.trim(), paymentTermsDays: days } });
      setDone(f.name.trim()); setF({ ...f, code: '', name: '' }); suppliers.reload();
    } catch (err) { setError(err); }
  }
  return (
    <details className="panel">
      <summary>New supplier</summary>
      <form onSubmit={submit} className="form-grid">
        <Field label="Code" hint="Capitals, digits, - or _" error={f.code && !/^[A-Z0-9_-]{2,20}$/.test(f.code) ? 'Use 2–20 capitals, digits, - or _' : null}><input value={f.code} onChange={set('code')} /></Field>
        <Field label="Supplier name"><input value={f.name} onChange={set('name')} maxLength={200} /></Field>
        <Field label="Country (2 letters)"><input value={f.countryCode} onChange={set('countryCode')} maxLength={2} /></Field>
        <Field label="Currency (3 letters)"><input value={f.defaultCurrency} onChange={set('defaultCurrency')} maxLength={3} /></Field>
        <Field label="Payment terms (days)"><input inputMode="numeric" value={f.paymentTermsDays} onChange={set('paymentTermsDays')} /></Field>
        <div className="form-actions"><button className="btn btn-primary" disabled={!ok}>Add supplier</button></div>
      </form>
      <ErrorBanner error={error} />
      {done && <Notice tone="ok">Added supplier “{done}”.</Notice>}
    </details>
  );
}

interface DraftLine { variantId: string; quantity: string; unitPrice: string }

function NewOrder({ onCreated }: { onCreated(id: string): void }) {
  const { can } = useAuth();
  const suppliers = useLoad<Supplier[]>('/v1/procurement/suppliers');
  const locations = useLoad<Location[]>('/v1/locations');
  const products = useLoad<Product[]>(can('catalog.read') ? '/v1/products?limit=200' : null);
  const [supplierId, setSupplierId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([{ variantId: '', quantity: '', unitPrice: '' }]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const key = useRef(newKey());
  const touch = () => { key.current = newKey(); };

  const active = (suppliers.data ?? []).filter((s) => s.status === 'active');
  const where = (locations.data ?? []).filter((l) => HOLDS_STOCK.has(l.type));
  const variants = useMemo(() => (products.data ?? []).flatMap((p) => p.variants.map((v) => ({ id: v.id, label: `${p.name} (${v.sku})` }))), [products.data]);
  const supplier = supplierId || active[0]?.id || '';
  const location = locationId || where[0]?.id || '';
  const resolved = lines.map((l) => ({ ...l, variantId: l.variantId || variants[0]?.id || '' }));
  const valid = supplier && location && resolved.every((l) => l.variantId && parseQuantity(l.quantity) && PRICE.test(l.unitPrice.trim()));

  const edit = (i: number, patch: Partial<DraftLine>) => { setLines(resolved.map((l, j) => (j === i ? { ...l, ...patch } : l))); touch(); };

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!valid) return;
    setBusy(true); setError(null);
    try {
      const po = await api<{ id: string }>('/v1/procurement/purchase-orders', {
        method: 'POST', idempotencyKey: key.current,
        body: {
          supplierId: supplier, destinationLocationId: location, ...(note.trim() ? { note: note.trim() } : {}),
          lines: resolved.map((l) => ({ variantId: l.variantId, quantity: l.quantity.trim(), unitPrice: l.unitPrice.trim() })),
        },
      });
      onCreated(po.id);
    } catch (err) { setError(err); setBusy(false); }
  }

  if (!can('catalog.read')) return null;
  return (
    <details className="panel">
      <summary>New purchase order</summary>
      {!active.length && !suppliers.loading && <Notice>Add a supplier first.</Notice>}
      <form onSubmit={submit}>
        <div className="form-grid">
          <Field label="Supplier"><select value={supplier} onChange={(e) => { setSupplierId(e.target.value); touch(); }}>{active.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.defaultCurrency})</option>)}</select></Field>
          <Field label="Deliver to"><select value={location} onChange={(e) => { setLocationId(e.target.value); touch(); }}>{where.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>
          <Field label="Note (optional)"><input value={note} onChange={(e) => { setNote(e.target.value); touch(); }} maxLength={1000} /></Field>
        </div>
        <fieldset className="payment">
          <legend>Lines</legend>
          {resolved.map((l, i) => (
            <div key={i} className="form-grid">
              <Field label={`Product ${i + 1}`}><select value={l.variantId} onChange={(e) => edit(i, { variantId: e.target.value })}>{variants.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}</select></Field>
              <Field label={`Quantity ${i + 1}`} hint="In the product's base unit" error={l.quantity && !parseQuantity(l.quantity) ? 'A positive number' : null}><input inputMode="decimal" value={l.quantity} onChange={(e) => edit(i, { quantity: e.target.value })} /></Field>
              <Field label={`Unit price ${i + 1}`} hint="Supplier currency, up to 4 decimals" error={l.unitPrice && !PRICE.test(l.unitPrice.trim()) ? 'Such as 12.5' : null}><input inputMode="decimal" value={l.unitPrice} onChange={(e) => edit(i, { unitPrice: e.target.value })} /></Field>
              {resolved.length > 1 && <div className="form-actions"><button type="button" className="btn btn-ghost" onClick={() => { setLines(resolved.filter((_, j) => j !== i)); touch(); }}>Remove line {i + 1}</button></div>}
            </div>
          ))}
          <button type="button" className="btn btn-ghost" onClick={() => { setLines([...resolved, { variantId: '', quantity: '', unitPrice: '' }]); touch(); }}>Add a line</button>
        </fieldset>
        <ErrorBanner error={error} />
        <button className="btn btn-primary" disabled={busy || !valid}>{busy ? 'Saving…' : 'Save as draft'}</button>
      </form>
    </details>
  );
}

function Order({ id, onBack, onChanged }: { id: string; onBack(): void; onChanged(): void }) {
  const { can, session } = useAuth();
  const po = useLoad<Po>(`/v1/procurement/purchase-orders/${id}`);
  const [error, setError] = useState<unknown>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const keys = useRef<Record<string, string>>({});
  const o = po.data;

  async function act(action: string, body?: unknown) {
    setBusy(true); setError(null);
    keys.current[action] ??= newKey();
    try {
      await api(`/v1/procurement/purchase-orders/${id}/${action}`, { method: 'POST', body: body ?? {}, idempotencyKey: keys.current[action] });
      delete keys.current[action];
      setNote(''); po.reload(); onChanged();
    } catch (e) { setError(e); }
    finally { setBusy(false); }
  }

  if (!o) return <><button type="button" className="btn btn-ghost" onClick={onBack}>← All orders</button><ErrorBanner error={po.error} />{po.loading && <Loading what="order" />}</>;
  const fmt = (m: number) => formatMoney(m, o.currency, o.minorUnit);
  const mine = o.createdBy === session?.user.id;
  const canReceive = (o.status === 'approved' || o.status === 'partially_received') && can('procurement.receive');

  return (
    <>
      <button type="button" className="btn btn-ghost" onClick={onBack}>← All orders</button>
      <section className="card" aria-label={`Order ${o.poNumber}`}>
        <h2>{o.poNumber} · {STATUS[o.status] ?? o.status}</h2>
        <p className="muted">{o.supplierName} → {o.destinationName}{o.note ? ` · ${o.note}` : ''}</p>
        {o.decisionNote && <Notice tone="warn">Approver’s note: {o.decisionNote}</Notice>}
        <div className="table-wrap">
          <table>
            <thead><tr><th scope="col">Product</th><th scope="col" className="num">Ordered</th><th scope="col" className="num">Price</th><th scope="col" className="num">Received</th><th scope="col" className="num">Outstanding</th><th scope="col" className="num">Line total</th></tr></thead>
            <tbody>
              {o.lines.map((l) => (
                <tr key={l.id}>
                  <th scope="row">{l.productName}<br /><span className="muted">{l.sku}</span></th>
                  <td className="num">{l.quantity}</td><td className="num">{l.unitPrice}</td><td className="num">{l.receivedQuantity}</td><td className="num">{l.outstandingQuantity}</td><td className="num">{fmt(l.totalMinor)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr><th scope="row" colSpan={5}>Total</th><td className="num"><strong>{fmt(o.totalMinor)}</strong></td></tr></tfoot>
          </table>
        </div>
        {o.receipts.length > 0 && <p className="muted">Receipts: {o.receipts.map((r) => r.receiptNumber).join(', ')}</p>}
        <ErrorBanner error={error} />

        {o.status === 'pending_approval' && can('procurement.approve') && (
          <div className="payment">
            {mine && <Notice tone="warn">You created this order, so someone else must approve it.</Notice>}
            <Field label="Note (required to send back)"><input value={note} onChange={(e) => { setNote(e.target.value); keys.current = {}; }} maxLength={1000} /></Field>
            <div className="row-end">
              <button type="button" className="btn btn-ghost" disabled={busy || note.trim().length < 3} onClick={() => act('reject', { note: note.trim() })}>Send back</button>
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => act('approve', note.trim() ? { note: note.trim() } : {})}>Approve</button>
            </div>
          </div>
        )}
        <div className="row-end">
          {o.status === 'draft' && can('procurement.create') && <button type="button" className="btn btn-primary" disabled={busy} onClick={() => act('submit')}>Submit for approval</button>}
          {['draft', 'pending_approval', 'approved'].includes(o.status) && can('procurement.create') && <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => act('cancel')}>Cancel order</button>}
          {o.status === 'partially_received' && can('procurement.approve') && <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => act('close')}>Stop expecting the rest</button>}
        </div>
      </section>
      {canReceive && <Receive key={o.receipts.length} po={o} onDone={() => { po.reload(); onChanged(); }} />}
    </>
  );
}

function Receive({ po, onDone }: { po: Po; onDone(): void }) {
  const open = po.lines.filter((l) => Number(l.outstandingQuantity) > 0);
  const [qty, setQty] = useState<Record<string, string>>({});
  const [lot, setLot] = useState<Record<string, string>>({});
  const [rejected, setRejected] = useState<Record<string, string>>({});
  const [why, setWhy] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const key = useRef(newKey());
  const touch = () => { key.current = newKey(); };

  const rows = open.filter((l) => qty[l.id]?.trim() || rejected[l.id]?.trim());
  const problem = (l: Line): string | null => {
    if (qty[l.id]?.trim() && !parseQuantity(qty[l.id]!)) return 'Quantity must be a positive number';
    if (rejected[l.id]?.trim() && !parseQuantity(rejected[l.id]!)) return 'Rejected quantity must be a positive number';
    if (rejected[l.id]?.trim() && (why[l.id]?.trim().length ?? 0) < 3) return 'Say why it was rejected';
    if (qty[l.id]?.trim() && l.tracking !== 'none' && !lot[l.id]?.trim()) return `${l.tracking === 'roll' ? 'Roll' : 'Lot'} code is required`;
    return null;
  };
  const invalid = rows.length === 0 || rows.some((l) => problem(l));

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (invalid) return;
    setBusy(true); setError(null);
    try {
      await api(`/v1/procurement/purchase-orders/${po.id}/receipts`, {
        method: 'POST', idempotencyKey: key.current,
        body: {
          ...(note.trim() ? { deliveryNote: note.trim() } : {}),
          lines: rows.map((l) => ({
            poLineId: l.id,
            ...(qty[l.id]?.trim() ? { quantity: qty[l.id]!.trim() } : {}),
            ...(lot[l.id]?.trim() && l.tracking !== 'none' ? { lotCode: lot[l.id]!.trim() } : {}),
            ...(rejected[l.id]?.trim() ? { rejectedQuantity: rejected[l.id]!.trim(), rejectReason: why[l.id]!.trim() } : {}),
          })),
        },
      });
      onDone();
    } catch (err) { setError(err); setBusy(false); }
  }

  return (
    <form className="card" onSubmit={submit} aria-label="Receive goods">
      <h2>Receive goods</h2>
      <p className="muted">Fill in only the lines that arrived. Rejected goods are recorded but never stocked.</p>
      {open.map((l) => (
        <fieldset key={l.id} className="payment">
          <legend>{l.productName} ({l.sku}) — {l.outstandingQuantity} outstanding</legend>
          <div className="form-grid">
            <Field label={`Accepted quantity, ${l.sku}`}><input inputMode="decimal" value={qty[l.id] ?? ''} onChange={(e) => { setQty({ ...qty, [l.id]: e.target.value }); touch(); }} /></Field>
            {l.tracking !== 'none' && <Field label={`${l.tracking === 'roll' ? 'Roll' : 'Lot'} code, ${l.sku}`}><input value={lot[l.id] ?? ''} onChange={(e) => { setLot({ ...lot, [l.id]: e.target.value }); touch(); }} /></Field>}
            <Field label={`Rejected quantity, ${l.sku}`}><input inputMode="decimal" value={rejected[l.id] ?? ''} onChange={(e) => { setRejected({ ...rejected, [l.id]: e.target.value }); touch(); }} /></Field>
            {rejected[l.id]?.trim() && <Field label={`Rejection reason, ${l.sku}`}><input value={why[l.id] ?? ''} onChange={(e) => { setWhy({ ...why, [l.id]: e.target.value }); touch(); }} /></Field>}
          </div>
          {rows.includes(l) && problem(l) && <p className="field-error">{problem(l)}</p>}
        </fieldset>
      ))}
      <Field label="Delivery note (optional)"><input value={note} onChange={(e) => { setNote(e.target.value); touch(); }} maxLength={200} /></Field>
      <ErrorBanner error={error} />
      <button className="btn btn-primary" disabled={busy || invalid}>{busy ? 'Working…' : 'Record receipt'}</button>
    </form>
  );
}
