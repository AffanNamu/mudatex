import { useEffect, useRef, useState } from 'react';
import { ErrorBanner, Loading, Notice } from '../../components/ui';
import { ScanBox } from '../../components/ScanBox';
import { useAuth } from '../../lib/auth';
import { useLoad } from '../../lib/hooks';
import { findByCode, plusOne, quantityFor, searchItems, type Sheet, type SheetItem } from '../../lib/stockSheet';
import type { Stock } from '../../lib/useStock';
import { Outcome } from './Outcome';

interface PoRow { id: string; poNumber: string; status: string; supplierName: string; destinationLocationId: string }
interface PoLine { id: string; variantId: string; sku: string; productName: string; tracking: 'none' | 'lot' | 'roll'; quantity: string; receivedQuantity: string; outstandingQuantity: string }
interface Po extends PoRow { lines: PoLine[] }

export function Receive({ stock }: { stock: Stock }) {
  const { can } = useAuth();
  const canPo = can('procurement.receive');
  const canFree = can('inventory.receive');
  const [mode, setMode] = useState<'po' | 'free'>(canPo ? 'po' : 'free');
  return (
    <section className="stock-section">
      {canPo && canFree && (
        <div className="stock-modes" role="group" aria-label="What are you receiving?">
          <button type="button" className={mode === 'po' ? 'btn btn-primary' : 'btn'} aria-pressed={mode === 'po'} onClick={() => setMode('po')}>Against an order</button>
          <button type="button" className={mode === 'free' ? 'btn btn-primary' : 'btn'} aria-pressed={mode === 'free'} onClick={() => setMode('free')}>Without an order</button>
        </div>
      )}
      {mode === 'po' ? <AgainstOrder stock={stock} /> : <WithoutOrder stock={stock} />}
    </section>
  );
}

const unitOf = (sheet: Sheet | undefined, variantId: string) => sheet?.items.find((i) => i.variantId === variantId) ?? { unitKind: 'decimal' as const, precision: 6, unit: '' };

function AgainstOrder({ stock }: { stock: Stock }) {
  const { sheet, locationId } = stock;
  const [orderId, setOrderId] = useState<string | null>(null);
  const list = useLoad<PoRow[]>(stock.online ? '/v1/procurement/purchase-orders?limit=100' : null);
  const open = (list.data ?? []).filter((p) => (p.status === 'approved' || p.status === 'partially_received') && p.destinationLocationId === locationId);
  const [submitted, setSubmitted] = useState<string | null>(null);

  if (orderId) return <Order key={orderId} stock={stock} id={orderId} onBack={() => { setOrderId(null); list.reload(); }} onSent={setSubmitted} />;
  return (
    <>
      <Outcome stock={stock} id={submitted} kind="receive" />
      {!stock.online && <Notice tone="warn">Orders can only be opened while you are online. You can still receive goods that have no order.</Notice>}
      <ErrorBanner error={list.error} />
      {list.loading ? <Loading what="orders" /> : (
        <ul className="stock-results" aria-label="Orders to receive here">
          {open.map((p) => <li key={p.id}><button type="button" className="btn" onClick={() => setOrderId(p.id)}><strong>{p.poNumber}</strong> <span className="muted">{p.supplierName}{p.status === 'partially_received' ? ' · part received' : ''}</span></button></li>)}
          {stock.online && !open.length && <li className="muted">No approved orders are waiting to be received at this place.</li>}
        </ul>
      )}
      {sheet === undefined && stock.online && <p className="muted small">Loading the stock list for scanning…</p>}
    </>
  );
}

interface Entry { qty: string; lot: string; rejected: string; reason: string }
const blank: Entry = { qty: '', lot: '', rejected: '', reason: '' };

function Order({ stock, id, onBack, onSent }: { stock: Stock; id: string; onBack(): void; onSent(id: string): void }) {
  const po = useLoad<Po>(`/v1/procurement/purchase-orders/${id}`);
  const [entries, setEntries] = useState<Record<string, Entry>>({});
  const [note, setNote] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const focus = useRef<string | null>(null);
  useEffect(() => { if (focus.current) { document.getElementById(`recv-${focus.current}`)?.focus(); focus.current = null; } });
  const o = po.data;
  if (po.loading || !o) return <><ErrorBanner error={po.error} /><Loading what="the order" /></>;

  const get = (lineId: string) => entries[lineId] ?? blank;
  const patch = (lineId: string, p: Partial<Entry>) => setEntries((cur) => ({ ...cur, [lineId]: { ...(cur[lineId] ?? blank), ...p } }));

  const onCode = (code: string) => {
    setMessage(null);
    const variantIds = new Set(findByCode(stock.sheet, code).map((i) => i.variantId));
    const line = o.lines.find((l) => variantIds.has(l.variantId) || l.sku.toLowerCase() === code.trim().toLowerCase());
    if (!line) { setMessage(`"${code}" is not on this order.`); return; }
    const u = unitOf(stock.sheet, line.variantId);
    if (u.unitKind === 'discrete') patch(line.id, { qty: plusOne(get(line.id).qty) });
    focus.current = line.id;
    setEntries((cur) => ({ ...cur }));
  };

  const lineProblems = (l: PoLine): string | null => {
    const e = get(l.id);
    const u = unitOf(stock.sheet, l.variantId);
    if (e.qty !== '' && quantityFor(e.qty, u) === null) return 'Check the quantity';
    if (e.rejected !== '' && quantityFor(e.rejected, u) === null) return 'Check the damaged quantity';
    if (e.qty !== '' && l.tracking !== 'none' && !e.lot.trim()) return `Enter the ${l.tracking === 'roll' ? 'roll' : 'lot'} code`;
    if (e.rejected !== '' && e.reason.trim().length < 3) return 'Say what was wrong with the damaged goods';
    return null;
  };
  const touched = o.lines.filter((l) => get(l.id).qty !== '' || get(l.id).rejected !== '');
  const bad = touched.some((l) => lineProblems(l));

  const send = async () => {
    const queued = await stock.submit({
      kind: 'receipt', path: `/v1/procurement/purchase-orders/${o.id}/receipts`, label: `Goods for ${o.poNumber} (${touched.length} ${touched.length === 1 ? 'line' : 'lines'})`,
      body: {
        deliveryNote: note.trim() || undefined,
        lines: touched.map((l) => {
          const e = get(l.id);
          return {
            poLineId: l.id,
            ...(e.qty !== '' ? { quantity: e.qty.trim() } : {}),
            ...(e.qty !== '' && l.tracking !== 'none' ? { lotCode: e.lot.trim() } : {}),
            ...(e.rejected !== '' ? { rejectedQuantity: e.rejected.trim(), rejectReason: e.reason.trim() } : {}),
          };
        }),
      },
    });
    onSent(queued.id);
    onBack();
  };

  return (
    <>
      <button type="button" className="btn btn-ghost" onClick={onBack}>← Orders</button>
      <h2>{o.poNumber} <span className="muted small">{o.supplierName}</span></h2>
      <p className="muted small">Scan each item as it comes off the delivery, then check the numbers.</p>
      <ScanBox onCode={onCode} label="Scan or type a barcode / SKU" />
      {message && <Notice tone="warn">{message}</Notice>}
      <ul className="stock-rows">
        {o.lines.map((l) => {
          const e = get(l.id);
          const u = unitOf(stock.sheet, l.variantId);
          const done = Number(l.outstandingQuantity) <= 0;
          const problem = (e.qty !== '' || e.rejected !== '') ? lineProblems(l) : null;
          return (
            <li key={l.id} className="stock-row stock-row-wide">
              <div className="stock-row-name"><strong>{l.productName}</strong><span className="muted small">{l.sku} · ordered {l.quantity}, received {l.receivedQuantity}, still to come {l.outstandingQuantity}{u.unit ? ` ${u.unit}` : ''}{done ? ' ✓' : ''}</span></div>
              <label className="stock-qty"><span className="sr-only">Received {l.productName}</span>
                <input id={`recv-${l.id}`} inputMode="decimal" value={e.qty} onChange={(ev) => patch(l.id, { qty: ev.target.value })} placeholder="Received" />
              </label>
              {l.tracking !== 'none' && <label className="stock-qty"><span className="sr-only">{l.tracking === 'roll' ? 'Roll' : 'Lot'} code for {l.productName}</span>
                <input value={e.lot} onChange={(ev) => patch(l.id, { lot: ev.target.value })} placeholder={l.tracking === 'roll' ? 'Roll code' : 'Lot code'} /></label>}
              <details className="stock-damaged" open={e.rejected !== ''}>
                <summary>Damaged or wrong</summary>
                <label className="stock-qty"><span className="sr-only">Damaged quantity of {l.productName}</span><input inputMode="decimal" value={e.rejected} onChange={(ev) => patch(l.id, { rejected: ev.target.value })} placeholder="How many" /></label>
                <label className="stock-qty"><span className="sr-only">What was wrong with {l.productName}</span><input value={e.reason} onChange={(ev) => patch(l.id, { reason: ev.target.value })} placeholder="What is wrong" /></label>
              </details>
              {problem && <span className="field-error">{problem}</span>}
            </li>
          );
        })}
      </ul>
      <label className="field"><span className="field-label">Delivery note number (optional)</span><input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} /></label>
      <button type="button" className="btn btn-primary btn-lg" disabled={!touched.length || bad} onClick={() => void send()}>Record receipt ({touched.length})</button>
    </>
  );
}

interface FreeRow { variantId: string; qty: string; lot: string }

function WithoutOrder({ stock }: { stock: Stock }) {
  const { sheet, locationId } = stock;
  const [rows, setRows] = useState<FreeRow[]>([]);
  const [reference, setReference] = useState('');
  const [search, setSearch] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<string | null>(null);
  const focus = useRef<string | null>(null);
  useEffect(() => { if (focus.current) { document.getElementById(`free-${focus.current}`)?.focus(); focus.current = null; } });
  const items = new Map((sheet?.items ?? []).map((i) => [i.variantId, i]));

  const add = (item: SheetItem, fromScan: boolean) => {
    setMessage(null); setSubmitted(null);
    setRows((cur) => {
      const at = cur.findIndex((r) => r.variantId === item.variantId);
      if (at >= 0) return fromScan && item.unitKind === 'discrete' ? cur.map((r, i) => (i === at ? { ...r, qty: plusOne(r.qty) } : r)) : cur;
      return [...cur, { variantId: item.variantId, qty: fromScan && item.unitKind === 'discrete' ? '1' : '', lot: '' }];
    });
    focus.current = item.variantId;
  };
  const onCode = (code: string) => {
    if (!sheet) { setMessage('The stock list is not on this phone yet. Connect once and press Refresh.'); return; }
    const found = findByCode(sheet, code);
    if (!found.length) setMessage(`Nothing in the stock list matches "${code}".`); else add(found[0]!, true);
  };
  const patch = (variantId: string, p: Partial<FreeRow>) => setRows((cur) => cur.map((r) => (r.variantId === variantId ? { ...r, ...p } : r)));
  const problem = (r: FreeRow) => {
    const it = items.get(r.variantId);
    if (!it || quantityFor(r.qty, it) === null) return 'Enter a quantity';
    if (it.tracking !== 'none' && !r.lot.trim()) return `Enter the ${it.tracking === 'roll' ? 'roll' : 'lot'} code`;
    return null;
  };
  const bad = rows.some(problem);
  const results = searchItems(sheet, search);

  const send = async () => {
    const queued = await stock.submit({
      kind: 'stock-receipt', path: '/v1/inventory/receipts', label: `Stock received without an order (${rows.length} ${rows.length === 1 ? 'line' : 'lines'}) at ${stock.location?.name ?? 'a place'}`,
      body: { locationId, reference: reference.trim() || undefined, lines: rows.map((r) => ({ variantId: r.variantId, quantity: r.qty.trim(), ...(items.get(r.variantId)?.tracking !== 'none' ? { lotCode: r.lot.trim() } : {}) })) },
    });
    setSubmitted(queued.id); setRows([]); setReference('');
  };

  return (
    <>
      <ScanBox onCode={onCode} label="Scan or type a barcode / SKU" />
      <label className="field"><span className="field-label">Or search by name</span><input type="search" value={search} onChange={(e) => setSearch(e.target.value)} autoComplete="off" /></label>
      {results.length > 0 && <ul className="stock-results" aria-label="Matches">{results.map((i) => <li key={i.variantId}><button type="button" className="btn" onClick={() => { add(i, false); setSearch(''); }}>{i.productName} <span className="muted">{i.sku}</span></button></li>)}</ul>}
      {message && <Notice tone="warn">{message}</Notice>}
      <Outcome stock={stock} id={submitted} kind="receive" />
      <ul className="stock-rows">
        {rows.map((r) => {
          const it = items.get(r.variantId);
          const p = r.qty !== '' ? problem(r) : null;
          return (
            <li key={r.variantId} className="stock-row">
              <div className="stock-row-name"><strong>{it?.productName ?? 'Unknown product'}</strong><span className="muted small">{it?.sku}</span></div>
              <label className="stock-qty"><span className="sr-only">Quantity of {it?.productName}</span><input id={`free-${r.variantId}`} inputMode="decimal" value={r.qty} onChange={(e) => patch(r.variantId, { qty: e.target.value })} placeholder="0" /><span className="muted small">{it?.unit}</span></label>
              {it && it.tracking !== 'none' && <label className="stock-qty"><span className="sr-only">{it.tracking === 'roll' ? 'Roll' : 'Lot'} code</span><input value={r.lot} onChange={(e) => patch(r.variantId, { lot: e.target.value })} placeholder={it.tracking === 'roll' ? 'Roll code' : 'Lot code'} /></label>}
              <button type="button" className="btn btn-ghost" aria-label={`Remove ${it?.productName ?? 'row'}`} onClick={() => setRows((cur) => cur.filter((x) => x.variantId !== r.variantId))}>✕</button>
              {p && <span className="field-error">{p}</span>}
            </li>
          );
        })}
      </ul>
      {rows.length > 0 && (
        <div className="stock-submit">
          <label className="field"><span className="field-label">Where it came from (optional)</span><input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={200} /></label>
          <button type="button" className="btn btn-primary btn-lg" disabled={bad} onClick={() => void send()}>Add to stock ({rows.length})</button>
        </div>
      )}
    </>
  );
}
