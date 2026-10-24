import { useMemo, useRef, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ErrorBanner, Field, Loading, Notice } from '../../components/ui';
import { ApiError, api, newKey } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useLoad } from '../../lib/hooks';
import { parseQuantity, percentToBps } from '../../lib/money';
import { HOLDS_STOCK, type Location } from './Layout';

interface Row { id: string; woNumber: string; status: string; outputSku: string; outputProductName: string; plannedQuantity: string; producedQuantity: string }
interface Allocation { lotId: string | null; lotCode: string | null; quantity: string; issuedQuantity: string }
interface Component { id: string; lineNo: number; sku: string; productName: string; tracking: string; requiredQuantity: string; issuedQuantity: string; returnedQuantity: string; allocatedQuantity: string; allocations: Allocation[] }
interface Operation { opNo: number; name: string; workCentreName: string; plannedMinutes: number; status: string; completedQuantity: string | null; scrapQuantity: string; qcCheckpoint: boolean }
interface Output { id: string; kind: string; sku: string; productName: string; lotCode: string | null; holdStatus: string | null; quantity: string }
interface Wo extends Row {
  bomId: string; locationId: string; requiresQc: boolean; toleranceBps: number; overProductionBps: number; varianceReason: string | null; note: string | null;
  components: Component[]; operations: Operation[]; outputs: Output[];
}
interface Bom { id: string; outputProductName: string; outputSku: string; version: number; status: string }
interface BomDetail { byproducts: { sku: string; productName: string; variantId: string; quantity: string }[] }
interface Reconciliation {
  outsideTolerance: boolean; toleranceBps: number;
  components: { lineNo: number; sku: string; issued: string; returned: string; netConsumed: string; expectedForOutput: string; variance: string; status: string }[];
  output: { planned: string; produced: string; scrapQuantity: string };
}
interface Shortage { sku: string; required: string; available: string; short: string }

const STATUS: Record<string, string> = { draft: 'Draft', released: 'Released', in_progress: 'In progress', completed: 'Completed', closed: 'Closed', cancelled: 'Cancelled' };

export function WorkOrders() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const selected = params.get('wo');
  const [status, setStatus] = useState('');
  const list = useLoad<Row[]>(`/v1/manufacturing/work-orders?limit=100${status ? `&status=${status}` : ''}`);
  const open = (id: string | null) => setParams(id ? { wo: id } : {});
  if (selected) return <Order id={selected} onBack={() => { list.reload(); open(null); }} />;
  return (
    <>
      {can('manufacturing.plan') && <NewOrder onCreated={(id) => { list.reload(); open(id); }} />}
      <div className="toolbar">
        <label className="field inline"><span className="field-label">Show</span>
          <select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All</option>{Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        </label>
      </div>
      <ErrorBanner error={list.error} />
      {list.loading && !list.data ? <Loading what="work orders" /> : (
        <div className="table-wrap">
          <table>
            <caption className="sr-only">Work orders</caption>
            <thead><tr><th scope="col">Order</th><th scope="col">Product</th><th scope="col" className="num">Planned</th><th scope="col" className="num">Made</th><th scope="col">Status</th></tr></thead>
            <tbody>
              {(list.data ?? []).map((w) => (
                <tr key={w.id}>
                  <th scope="row"><button type="button" className="link" onClick={() => open(w.id)}>{w.woNumber}</button></th>
                  <td>{w.outputProductName} <span className="muted">({w.outputSku})</span></td><td className="num">{w.plannedQuantity}</td><td className="num">{w.producedQuantity}</td><td>{STATUS[w.status] ?? w.status}</td>
                </tr>
              ))}
              {!list.data?.length && <tr><td colSpan={5} className="muted">No work orders yet.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function NewOrder({ onCreated }: { onCreated(id: string): void }) {
  const boms = useLoad<Bom[]>('/v1/manufacturing/boms?status=active');
  const locations = useLoad<Location[]>('/v1/locations');
  const where = (locations.data ?? []).filter((l) => HOLDS_STOCK.has(l.type));
  const [bomId, setBomId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [qty, setQty] = useState('');
  const [start, setStart] = useState('');
  const [tolerance, setTolerance] = useState('5');
  const [over, setOver] = useState('0');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const key = useRef(newKey());
  const touch = () => { key.current = newKey(); };
  const bom = bomId || boms.data?.[0]?.id || '';
  const loc = locationId || where[0]?.id || '';
  const tolBps = percentToBps(tolerance);
  const overBps = percentToBps(over);
  const valid = bom && loc && parseQuantity(qty) && tolBps !== null && overBps !== null && overBps <= 5000;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!valid) return;
    setBusy(true); setError(null);
    try {
      const wo = await api<{ id: string }>('/v1/manufacturing/work-orders', {
        method: 'POST', idempotencyKey: key.current,
        body: { bomId: bom, locationId: loc, quantity: qty.trim(), toleranceBps: tolBps, overProductionBps: overBps, ...(start ? { plannedStart: start } : {}) },
      });
      onCreated(wo.id);
    } catch (err) { setError(err); setBusy(false); }
  }
  return (
    <details className="panel">
      <summary>New work order</summary>
      {boms.data && !boms.data.length && <Notice>There is no approved bill of materials to make anything from yet.</Notice>}
      <form onSubmit={submit} className="form-grid">
        <Field label="Make"><select value={bom} onChange={(e) => { setBomId(e.target.value); touch(); }}>{(boms.data ?? []).map((b) => <option key={b.id} value={b.id}>{b.outputProductName} ({b.outputSku}) v{b.version}</option>)}</select></Field>
        <Field label="At"><select value={loc} onChange={(e) => { setLocationId(e.target.value); touch(); }}>{where.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>
        <Field label="Quantity to make" error={qty && !parseQuantity(qty) ? 'A positive number' : null}><input inputMode="decimal" value={qty} onChange={(e) => { setQty(e.target.value); touch(); }} /></Field>
        <Field label="Planned start (optional)"><input type="date" value={start} onChange={(e) => { setStart(e.target.value); touch(); }} /></Field>
        <Field label="Material tolerance %" hint="How far actual use may stray before closing needs a reason" error={tolBps === null ? 'Such as 5' : null}><input inputMode="decimal" value={tolerance} onChange={(e) => { setTolerance(e.target.value); touch(); }} /></Field>
        <Field label="Over-production allowed %" error={overBps === null || overBps > 5000 ? 'Between 0 and 50' : null}><input inputMode="decimal" value={over} onChange={(e) => { setOver(e.target.value); touch(); }} /></Field>
        <div className="form-actions"><button className="btn btn-primary" disabled={busy || !valid}>{busy ? 'Saving…' : 'Create work order'}</button></div>
      </form>
      <ErrorBanner error={error} />
    </details>
  );
}

function Order({ id, onBack }: { id: string; onBack(): void }) {
  const { can } = useAuth();
  const wo = useLoad<Wo>(`/v1/manufacturing/work-orders/${id}`);
  const o = wo.data;
  const bom = useLoad<BomDetail>(o ? `/v1/manufacturing/boms/${o.bomId}` : null);
  const rec = useLoad<Reconciliation>(o && ['in_progress', 'completed', 'closed'].includes(o.status) ? `/v1/manufacturing/work-orders/${id}/reconciliation` : null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');
  const keys = useRef<Record<string, string>>({});

  const refresh = () => { wo.reload(); rec.reload(); };
  async function act(name: string, path: string, body: unknown = {}) {
    setBusy(true); setError(null);
    keys.current[name] ??= newKey();
    try { await api(`/v1/manufacturing/work-orders/${id}/${path}`, { method: 'POST', body, idempotencyKey: keys.current[name] }); delete keys.current[name]; refresh(); }
    catch (e) { setError(e); }
    finally { setBusy(false); }
  }

  if (!o) return <><button type="button" className="btn btn-ghost" onClick={onBack}>← All work orders</button><ErrorBanner error={wo.error} />{wo.loading && <Loading what="work order" />}</>;
  const live = o.status === 'released' || o.status === 'in_progress';
  const shortages = error instanceof ApiError && error.code === 'shortage' ? ((error.details as { shortages?: Shortage[] } | undefined)?.shortages ?? []) : [];
  const allOpsDone = o.operations.every((x) => x.status === 'done');

  return (
    <>
      <button type="button" className="btn btn-ghost" onClick={onBack}>← All work orders</button>
      <section className="card" aria-label={`Work order ${o.woNumber}`}>
        <h2>{o.woNumber} · {STATUS[o.status] ?? o.status}</h2>
        <p className="muted">{o.outputProductName} ({o.outputSku}) · planned {o.plannedQuantity} · made {o.producedQuantity}{o.requiresQc ? ' · output waits for inspection' : ''}</p>
        {o.varianceReason && <Notice tone="warn">Closed outside tolerance: {o.varianceReason}</Notice>}

        <div className="table-wrap">
          <table>
            <caption className="sr-only">Materials</caption>
            <thead><tr><th scope="col">Material</th><th scope="col" className="num">Needed</th><th scope="col" className="num">Reserved</th><th scope="col" className="num">Issued</th><th scope="col" className="num">Returned</th></tr></thead>
            <tbody>{o.components.map((c) => (
              <tr key={c.id}><th scope="row">{c.productName} <span className="muted">({c.sku})</span></th><td className="num">{c.requiredQuantity}</td><td className="num">{c.allocatedQuantity}</td><td className="num">{c.issuedQuantity}</td><td className="num">{c.returnedQuantity}</td></tr>
            ))}</tbody>
          </table>
        </div>

        {o.operations.length > 0 && (
          <div className="table-wrap">
            <table>
              <caption className="sr-only">Steps</caption>
              <thead><tr><th scope="col">Step</th><th scope="col">Work centre</th><th scope="col" className="num">Planned min</th><th scope="col">Status</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>{o.operations.map((op) => (
                <tr key={op.opNo}>
                  <th scope="row">{op.opNo} {op.name}{op.qcCheckpoint ? ' (inspection)' : ''}</th><td>{op.workCentreName}</td><td className="num">{op.plannedMinutes}</td>
                  <td>{op.status === 'done' ? `Done: ${op.completedQuantity} good, ${op.scrapQuantity} scrap` : op.status.replace('_', ' ')}</td>
                  <td>
                    {live && can('manufacturing.operate') && op.status === 'pending' && <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => act(`start${op.opNo}`, `operations/${op.opNo}/start`)} aria-label={`Start ${op.name}`}>Start</button>}
                    {live && can('manufacturing.operate') && op.status === 'in_progress' && <CompleteStep op={op} onDone={refresh} woId={id} />}
                  </td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}

        {o.outputs.length > 0 && (
          <div className="table-wrap">
            <table>
              <caption className="sr-only">Output</caption>
              <thead><tr><th scope="col">Output</th><th scope="col">Lot / roll</th><th scope="col" className="num">Quantity</th><th scope="col">Quality</th></tr></thead>
              <tbody>{o.outputs.map((x) => <tr key={x.id}><th scope="row">{x.productName} <span className="muted">({x.sku}){x.kind === 'byproduct' ? ' by-product' : ''}</span></th><td>{x.lotCode ?? '—'}</td><td className="num">{x.quantity}</td><td>{x.holdStatus === 'quarantined' ? 'On hold' : x.holdStatus ? 'Available' : ''}</td></tr>)}</tbody>
            </table>
          </div>
        )}

        <ErrorBanner error={shortages.length ? null : error} />
        {shortages.length > 0 && (
          <div role="alert" className="banner banner-error">
            Not enough free material to release this work order. Nothing was reserved.
            <ul>{shortages.map((s) => <li key={s.sku}>{s.sku}: needs {s.required}, {s.available} free, short by {s.short}</li>)}</ul>
          </div>
        )}

        <div className="row-end">
          {o.status === 'draft' && can('manufacturing.plan') && <button type="button" className="btn btn-primary" disabled={busy} onClick={() => act('release', 'release')}>Release and reserve material</button>}
          {(o.status === 'draft' || o.status === 'released') && can('manufacturing.plan') && <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => act('cancel', 'cancel')}>Cancel order</button>}
          {o.status === 'in_progress' && can('manufacturing.close') && <button type="button" className="btn btn-primary" disabled={busy || !allOpsDone} onClick={() => act('complete', 'complete')}>Mark complete</button>}
        </div>
        {o.status === 'in_progress' && can('manufacturing.close') && !allOpsDone && <p className="muted">Finish every step before marking the order complete.</p>}
      </section>

      {live && can('manufacturing.issue') && <Issue key={o.components.map((c) => c.issuedQuantity).join()} wo={o} onDone={refresh} />}
      {live && can('manufacturing.operate') && <RecordOutput wo={o} byproducts={bom.data?.byproducts ?? []} onDone={refresh} />}

      {rec.data && (o.status === 'completed' || o.status === 'closed' || o.status === 'in_progress') && (
        <section className="card" aria-label="Material use">
          <h2>Material use against plan</h2>
          <p className="muted">Tolerance {rec.data.toleranceBps / 100}% · made {rec.data.output.produced} of {rec.data.output.planned}</p>
          <div className="table-wrap">
            <table>
              <thead><tr><th scope="col">Material</th><th scope="col" className="num">Used (net)</th><th scope="col" className="num">Expected for output</th><th scope="col" className="num">Difference</th><th scope="col">Result</th></tr></thead>
              <tbody>{rec.data.components.map((c) => <tr key={c.lineNo}><th scope="row">{c.sku}</th><td className="num">{c.netConsumed}</td><td className="num">{c.expectedForOutput}</td><td className="num">{c.variance}</td><td>{c.status.replace('_', ' ')}</td></tr>)}</tbody>
            </table>
          </div>
          {o.status === 'completed' && can('manufacturing.close') && (
            <form onSubmit={(e) => { e.preventDefault(); void act('close', 'close', rec.data!.outsideTolerance ? { varianceReason: reason.trim() } : {}); }}>
              {rec.data.outsideTolerance
                ? <><Notice tone="warn">Material use is outside tolerance. Say why before closing.</Notice>
                    <Field label="Reason for the difference" error={reason && reason.trim().length < 5 ? 'At least 5 characters' : null}><input value={reason} onChange={(e) => { setReason(e.target.value); delete keys.current.close; }} maxLength={1000} /></Field></>
                : <Notice tone="ok">Material use is within tolerance.</Notice>}
              <button className="btn btn-primary" disabled={busy || (rec.data.outsideTolerance && reason.trim().length < 5)}>Close work order</button>
            </form>
          )}
        </section>
      )}
    </>
  );
}

function CompleteStep({ op, woId, onDone }: { op: Operation; woId: string; onDone(): void }) {
  const [good, setGood] = useState('');
  const [scrap, setScrap] = useState('0');
  const [error, setError] = useState<unknown>(null);
  const key = useRef(newKey());
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try { await api(`/v1/manufacturing/work-orders/${woId}/operations/${op.opNo}/complete`, { method: 'POST', idempotencyKey: key.current, body: { completedQuantity: good.trim(), scrapQuantity: scrap.trim() || '0' } }); onDone(); }
    catch (err) { setError(err); }
  }
  return (
    <form onSubmit={submit} className="inline-form" aria-label={`Complete ${op.name}`}>
      <input className="narrow" aria-label={`Good quantity, ${op.name}`} inputMode="decimal" value={good} onChange={(e) => { setGood(e.target.value); key.current = newKey(); }} placeholder="Good" />
      <input className="narrow" aria-label={`Scrap quantity, ${op.name}`} inputMode="decimal" value={scrap} onChange={(e) => { setScrap(e.target.value); key.current = newKey(); }} placeholder="Scrap" />
      <button className="btn btn-primary" disabled={!parseQuantity(good) || (scrap.trim() !== '' && !/^\d+(\.\d+)?$/.test(scrap.trim()))}>Finish {op.name}</button>
      <ErrorBanner error={error} />
    </form>
  );
}

function Issue({ wo, onDone }: { wo: Wo; onDone(): void }) {
  // One row per reserved lot: the quantity left to issue is the default, and the person can lower it.
  const rows = useMemo(() => wo.components.flatMap((c) => c.allocations.map((a) => ({
    key: `${c.id}:${a.lotId ?? ''}`, componentId: c.id, lotId: a.lotId, label: `${c.sku}${a.lotCode ? ` · ${a.lotCode}` : ''}`,
    left: String(Number(a.quantity) - Number(a.issuedQuantity)),
  })).filter((r) => Number(r.left) > 0)), [wo.components]);
  const [qty, setQty] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const key = useRef(newKey());
  const value = (r: { key: string; left: string }) => qty[r.key] ?? r.left;
  const picked = rows.filter((r) => value(r).trim() && Number(value(r)) !== 0);
  const bad = picked.some((r) => !parseQuantity(value(r)));

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!picked.length || bad) return;
    setBusy(true); setError(null);
    try {
      await api(`/v1/manufacturing/work-orders/${wo.id}/issues`, { method: 'POST', idempotencyKey: key.current, body: { lines: picked.map((r) => ({ componentId: r.componentId, ...(r.lotId ? { lotId: r.lotId } : {}), quantity: value(r).trim() })) } });
      onDone();
    } catch (err) { setError(err); setBusy(false); }
  }
  if (!rows.length) return null;
  return (
    <form className="card" onSubmit={submit} aria-label="Issue material">
      <h2>Issue material to the floor</h2>
      <p className="muted">Quantities default to what is still reserved. Lower them to issue less.</p>
      {rows.map((r) => (
        <Field key={r.key} label={`Issue ${r.label}`} hint={`${r.left} still reserved`} error={value(r).trim() && !parseQuantity(value(r)) && Number(value(r)) !== 0 ? 'A positive number' : null}>
          <input inputMode="decimal" value={value(r)} onChange={(e) => { setQty({ ...qty, [r.key]: e.target.value }); key.current = newKey(); }} />
        </Field>
      ))}
      <ErrorBanner error={error} />
      <button className="btn btn-primary" disabled={busy || !picked.length || bad}>{busy ? 'Working…' : 'Issue material'}</button>
    </form>
  );
}

function RecordOutput({ wo, byproducts, onDone }: { wo: Wo; byproducts: BomDetail['byproducts']; onDone(): void }) {
  const [qty, setQty] = useState('');
  const [lot, setLot] = useState('');
  const [bp, setBp] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const key = useRef(newKey());
  const touch = () => { key.current = newKey(); };
  const bpRows = byproducts.filter((p) => bp[p.variantId]?.trim());

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!parseQuantity(qty)) return;
    setBusy(true); setError(null);
    try {
      await api(`/v1/manufacturing/work-orders/${wo.id}/outputs`, {
        method: 'POST', idempotencyKey: key.current,
        body: { quantity: qty.trim(), ...(lot.trim() ? { lotCode: lot.trim() } : {}), byproducts: bpRows.map((p) => ({ variantId: p.variantId, quantity: bp[p.variantId]!.trim() })) },
      });
      setQty(''); setLot(''); setBp({}); key.current = newKey(); onDone();
    } catch (err) { setError(err); }
    finally { setBusy(false); }
  }
  return (
    <form className="card" onSubmit={submit} aria-label="Record output">
      <h2>Record finished goods</h2>
      {wo.requiresQc && <Notice>This product is inspected: the new lot goes on hold until someone else releases it.</Notice>}
      <div className="form-grid">
        <Field label="Good quantity made" error={qty && !parseQuantity(qty) ? 'A positive number' : null}><input inputMode="decimal" value={qty} onChange={(e) => { setQty(e.target.value); touch(); }} /></Field>
        <Field label="Lot / roll code" hint="Leave blank for products not tracked by lot"><input value={lot} onChange={(e) => { setLot(e.target.value); touch(); }} maxLength={100} /></Field>
        {byproducts.map((p) => (
          <Field key={p.variantId} label={`By-product ${p.productName}`}><input inputMode="decimal" value={bp[p.variantId] ?? ''} onChange={(e) => { setBp({ ...bp, [p.variantId]: e.target.value }); touch(); }} /></Field>
        ))}
      </div>
      <ErrorBanner error={error} />
      <button className="btn btn-primary" disabled={busy || !parseQuantity(qty)}>{busy ? 'Working…' : 'Record output'}</button>
    </form>
  );
}
