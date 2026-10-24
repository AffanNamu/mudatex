import { useMemo, useRef, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ErrorBanner, Field, Loading, Notice } from '../../components/ui';
import { api, newKey } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useLoad } from '../../lib/hooks';
import { parseQuantity, percentToBps } from '../../lib/money';
import type { Product } from '../Catalogue';
import { HOLDS_STOCK, type Location } from './Layout';

interface Row { id: string; outputSku: string; outputProductName: string; version: number; status: string; outputQuantity: string; createdBy: string }
interface Bom extends Row {
  expectedYieldBps: number; requiresQc: boolean; note: string | null;
  components: { lineNo: number; sku: string; productName: string; quantity: string; scrapBps: number }[];
  byproducts: { lineNo: number; sku: string; productName: string; quantity: string }[];
  operations: { opNo: number; name: string; workCentreName: string; setupMinutes: number; runMinutesPerUnit: string; qcCheckpoint: boolean }[];
}
interface WorkCentre { id: string; code: string; name: string; locationId: string }
interface Requirements { plannedQuantity: string; canRelease: boolean; fullyCoveredByOnOrder: boolean; lines: { variantId: string; sku: string; required: string; available: string; shortage: string; onOrder: string; shortageAfterOnOrder: string }[] }

const pct = (bps: number) => `${bps / 100}%`;
const PRICE = /^\d+(\.\d{1,4})?$/;

export function Boms() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const selected = params.get('bom');
  const list = useLoad<Row[]>('/v1/manufacturing/boms');
  const open = (id: string | null) => setParams(id ? { bom: id } : {});
  if (selected) return <BomView id={selected} onBack={() => { list.reload(); open(null); }} />;
  return (
    <>
      {can('manufacturing.workcentre.manage') && <NewWorkCentre />}
      {can('manufacturing.bom.manage') && <NewBom onCreated={(id) => { list.reload(); open(id); }} />}
      <ErrorBanner error={list.error} />
      {list.loading && !list.data ? <Loading what="bills of materials" /> : (
        <div className="table-wrap">
          <table>
            <caption className="sr-only">Bills of materials</caption>
            <thead><tr><th scope="col">Product</th><th scope="col">Version</th><th scope="col">Makes</th><th scope="col">Status</th></tr></thead>
            <tbody>
              {(list.data ?? []).map((b) => (
                <tr key={b.id}>
                  <th scope="row"><button type="button" className="link" onClick={() => open(b.id)}>{b.outputProductName} ({b.outputSku})</button></th>
                  <td>v{b.version}</td><td>{b.outputQuantity}</td><td>{b.status}</td>
                </tr>
              ))}
              {!list.data?.length && <tr><td colSpan={4} className="muted">No bills of materials yet.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function NewWorkCentre() {
  const locations = useLoad<Location[]>('/v1/locations');
  const [f, setF] = useState({ locationId: '', code: '', name: '' });
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<string | null>(null);
  const where = (locations.data ?? []).filter((l) => HOLDS_STOCK.has(l.type));
  const loc = f.locationId || where[0]?.id || '';
  const ok = loc && /^[A-Z0-9_-]{2,20}$/.test(f.code) && f.name.trim();
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null); setDone(null);
    try { await api('/v1/manufacturing/work-centres', { method: 'POST', body: { locationId: loc, code: f.code, name: f.name.trim() } }); setDone(f.name.trim()); setF({ ...f, code: '', name: '' }); }
    catch (err) { setError(err); }
  }
  return (
    <details className="panel">
      <summary>New work centre</summary>
      <form onSubmit={submit} className="form-grid">
        <Field label="Location"><select value={loc} onChange={(e) => setF({ ...f, locationId: e.target.value })}>{where.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>
        <Field label="Work centre code" hint="Capitals, digits, - or _" error={f.code && !/^[A-Z0-9_-]{2,20}$/.test(f.code) ? '2–20 capitals, digits, - or _' : null}><input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} /></Field>
        <Field label="Work centre name"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={100} /></Field>
        <div className="form-actions"><button className="btn btn-primary" disabled={!ok}>Add work centre</button></div>
      </form>
      <ErrorBanner error={error} />
      {done && <Notice tone="ok">Added “{done}”.</Notice>}
    </details>
  );
}

interface CompDraft { variantId: string; quantity: string; scrap: string }
interface OpDraft { name: string; workCentreId: string; setup: string; run: string; qc: boolean }

function NewBom({ onCreated }: { onCreated(id: string): void }) {
  const { can } = useAuth();
  const products = useLoad<Product[]>(can('catalog.read') ? '/v1/products?limit=200' : null);
  const centres = useLoad<WorkCentre[]>('/v1/manufacturing/work-centres');
  const variants = useMemo(() => (products.data ?? []).flatMap((p) => p.variants.map((v) => ({ id: v.id, label: `${p.name} (${v.sku})`, tracking: v.tracking }))), [products.data]);
  const [output, setOutput] = useState('');
  const [outQty, setOutQty] = useState('1');
  const [yieldText, setYieldText] = useState('100');
  const [requiresQc, setRequiresQc] = useState(false);
  const [comps, setComps] = useState<CompDraft[]>([{ variantId: '', quantity: '', scrap: '' }]);
  const [ops, setOps] = useState<OpDraft[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const key = useRef(newKey());
  const touch = () => { key.current = newKey(); };

  const first = variants[0]?.id ?? '';
  const outputId = output || first;
  const outputTracking = variants.find((v) => v.id === outputId)?.tracking;
  const yieldBps = percentToBps(yieldText);
  const rc = comps.map((c) => ({ ...c, variantId: c.variantId || first }));
  const centre = (o: OpDraft) => o.workCentreId || centres.data?.[0]?.id || '';
  const valid = outputId && parseQuantity(outQty) && yieldBps && yieldBps > 0
    && rc.every((c) => c.variantId && parseQuantity(c.quantity) && percentToBps(c.scrap) !== null)
    && ops.every((o) => o.name.trim() && centre(o) && /^\d{1,5}$/.test(o.setup || '0') && PRICE.test(o.run || '0'))
    && (!requiresQc || outputTracking !== 'none');

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!valid) return;
    setBusy(true); setError(null);
    try {
      const b = await api<{ id: string }>('/v1/manufacturing/boms', {
        method: 'POST', idempotencyKey: key.current,
        body: {
          outputVariantId: outputId, outputQuantity: outQty.trim(), expectedYieldBps: yieldBps, requiresQc,
          components: rc.map((c) => ({ variantId: c.variantId, quantity: c.quantity.trim(), scrapBps: percentToBps(c.scrap) ?? 0 })),
          operations: ops.map((o, i) => ({ opNo: (i + 1) * 10, name: o.name.trim(), workCentreId: centre(o), setupMinutes: Number(o.setup || 0), runMinutesPerUnit: o.run || '0', qcCheckpoint: o.qc })),
        },
      });
      onCreated(b.id);
    } catch (err) { setError(err); setBusy(false); }
  }

  if (!can('catalog.read')) return null;
  return (
    <details className="panel">
      <summary>New bill of materials</summary>
      <form onSubmit={submit}>
        <div className="form-grid">
          <Field label="Finished product"><select value={outputId} onChange={(e) => { setOutput(e.target.value); touch(); }}>{variants.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}</select></Field>
          <Field label="Makes (quantity)" error={outQty && !parseQuantity(outQty) ? 'A positive number' : null}><input inputMode="decimal" value={outQty} onChange={(e) => { setOutQty(e.target.value); touch(); }} /></Field>
          <Field label="Expected yield %" hint="100 means nothing is lost" error={yieldBps === null || yieldBps === 0 ? 'Between 0.01 and 100' : null}><input inputMode="decimal" value={yieldText} onChange={(e) => { setYieldText(e.target.value); touch(); }} /></Field>
          <label className="field"><span className="field-label">Quality check</span><span><input type="checkbox" checked={requiresQc} onChange={(e) => { setRequiresQc(e.target.checked); touch(); }} /> Output waits on hold for inspection</span></label>
        </div>
        {requiresQc && outputTracking === 'none' && <Notice tone="warn">A product that needs a quality check must be tracked by lot or roll, so it can be held on its own.</Notice>}
        <fieldset className="payment">
          <legend>Materials</legend>
          {rc.map((c, i) => (
            <div key={i} className="form-grid">
              <Field label={`Material ${i + 1}`}><select value={c.variantId} onChange={(e) => { setComps(rc.map((x, j) => (j === i ? { ...x, variantId: e.target.value } : x))); touch(); }}>{variants.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}</select></Field>
              <Field label={`Quantity ${i + 1}`} hint="Per batch, in the material's base unit" error={c.quantity && !parseQuantity(c.quantity) ? 'A positive number' : null}><input inputMode="decimal" value={c.quantity} onChange={(e) => { setComps(rc.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x))); touch(); }} /></Field>
              <Field label={`Allowed waste % ${i + 1}`} error={percentToBps(c.scrap) === null ? 'Such as 5 or 2.5' : null}><input inputMode="decimal" value={c.scrap} onChange={(e) => { setComps(rc.map((x, j) => (j === i ? { ...x, scrap: e.target.value } : x))); touch(); }} /></Field>
              {rc.length > 1 && <div className="form-actions"><button type="button" className="btn btn-ghost" onClick={() => { setComps(rc.filter((_, j) => j !== i)); touch(); }}>Remove material {i + 1}</button></div>}
            </div>
          ))}
          <button type="button" className="btn btn-ghost" onClick={() => { setComps([...rc, { variantId: '', quantity: '', scrap: '' }]); touch(); }}>Add a material</button>
        </fieldset>
        <fieldset className="payment">
          <legend>Steps (optional)</legend>
          {ops.map((o, i) => (
            <div key={i} className="form-grid">
              <Field label={`Step ${i + 1} name`}><input value={o.name} onChange={(e) => { setOps(ops.map((x, j) => (j === i ? { ...x, name: e.target.value } : x))); touch(); }} /></Field>
              <Field label={`Step ${i + 1} work centre`}><select value={centre(o)} onChange={(e) => { setOps(ops.map((x, j) => (j === i ? { ...x, workCentreId: e.target.value } : x))); touch(); }}>{(centres.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.code} {w.name}</option>)}</select></Field>
              <Field label={`Step ${i + 1} setup minutes`}><input inputMode="numeric" value={o.setup} onChange={(e) => { setOps(ops.map((x, j) => (j === i ? { ...x, setup: e.target.value } : x))); touch(); }} /></Field>
              <Field label={`Step ${i + 1} minutes per unit`}><input inputMode="decimal" value={o.run} onChange={(e) => { setOps(ops.map((x, j) => (j === i ? { ...x, run: e.target.value } : x))); touch(); }} /></Field>
              <label className="field"><span className="field-label">Inspection point</span><span><input type="checkbox" checked={o.qc} onChange={(e) => { setOps(ops.map((x, j) => (j === i ? { ...x, qc: e.target.checked } : x))); touch(); }} /> Step {i + 1} is an inspection point</span></label>
              <div className="form-actions"><button type="button" className="btn btn-ghost" onClick={() => { setOps(ops.filter((_, j) => j !== i)); touch(); }}>Remove step {i + 1}</button></div>
            </div>
          ))}
          <button type="button" className="btn btn-ghost" onClick={() => { setOps([...ops, { name: '', workCentreId: '', setup: '0', run: '0', qc: false }]); touch(); }} disabled={!centres.data?.length}>Add a step</button>
          {!centres.data?.length && <p className="muted">Add a work centre first to define steps.</p>}
        </fieldset>
        <ErrorBanner error={error} />
        <button className="btn btn-primary" disabled={busy || !valid}>{busy ? 'Saving…' : 'Save as draft'}</button>
      </form>
    </details>
  );
}

function BomView({ id, onBack }: { id: string; onBack(): void }) {
  const { can, session } = useAuth();
  const bom = useLoad<Bom>(`/v1/manufacturing/boms/${id}`);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const keys = useRef<Record<string, string>>({});
  const b = bom.data;

  async function act(action: 'approve' | 'retire') {
    setBusy(true); setError(null);
    keys.current[action] ??= newKey();
    try { await api(`/v1/manufacturing/boms/${id}/${action}`, { method: 'POST', body: {}, idempotencyKey: keys.current[action] }); delete keys.current[action]; bom.reload(); }
    catch (e) { setError(e); }
    finally { setBusy(false); }
  }
  if (!b) return <><button type="button" className="btn btn-ghost" onClick={onBack}>← All bills of materials</button><ErrorBanner error={bom.error} />{bom.loading && <Loading what="bill of materials" />}</>;
  const mine = b.createdBy === session?.user.id;
  return (
    <>
      <button type="button" className="btn btn-ghost" onClick={onBack}>← All bills of materials</button>
      <section className="card" aria-label={`${b.outputProductName} version ${b.version}`}>
        <h2>{b.outputProductName} ({b.outputSku}) · v{b.version} · {b.status}</h2>
        <p className="muted">Makes {b.outputQuantity} · expected yield {pct(b.expectedYieldBps)}{b.requiresQc ? ' · output is held for inspection' : ''}</p>
        <div className="table-wrap">
          <table>
            <caption className="sr-only">Materials</caption>
            <thead><tr><th scope="col">Material</th><th scope="col" className="num">Quantity</th><th scope="col" className="num">Allowed waste</th></tr></thead>
            <tbody>{b.components.map((c) => <tr key={c.lineNo}><th scope="row">{c.productName} <span className="muted">({c.sku})</span></th><td className="num">{c.quantity}</td><td className="num">{pct(c.scrapBps)}</td></tr>)}</tbody>
          </table>
        </div>
        {b.operations.length > 0 && (
          <div className="table-wrap">
            <table>
              <caption className="sr-only">Steps</caption>
              <thead><tr><th scope="col">Step</th><th scope="col">Work centre</th><th scope="col" className="num">Setup min</th><th scope="col" className="num">Min per unit</th><th scope="col">Inspection</th></tr></thead>
              <tbody>{b.operations.map((o) => <tr key={o.opNo}><th scope="row">{o.opNo} {o.name}</th><td>{o.workCentreName}</td><td className="num">{o.setupMinutes}</td><td className="num">{o.runMinutesPerUnit}</td><td>{o.qcCheckpoint ? 'Yes' : ''}</td></tr>)}</tbody>
            </table>
          </div>
        )}
        {b.byproducts.length > 0 && <p className="muted">By-products: {b.byproducts.map((p) => `${p.quantity} × ${p.productName}`).join(', ')}</p>}
        <ErrorBanner error={error} />
        {b.status === 'draft' && can('manufacturing.bom.approve') && mine && <Notice tone="warn">You created this version, so someone else must approve it.</Notice>}
        <div className="row-end">
          {b.status === 'draft' && can('manufacturing.bom.approve') && <button type="button" className="btn btn-primary" disabled={busy} onClick={() => act('approve')}>Approve</button>}
          {b.status === 'active' && can('manufacturing.bom.approve') && <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => act('retire')}>Retire this version</button>}
        </div>
      </section>
      {b.status === 'active' && <MaterialCheck bomId={id} />}
    </>
  );
}

function MaterialCheck({ bomId }: { bomId: string }) {
  const locations = useLoad<Location[]>('/v1/locations');
  const where = (locations.data ?? []).filter((l) => HOLDS_STOCK.has(l.type));
  const [locationId, setLocationId] = useState('');
  const [qty, setQty] = useState('');
  const loc = locationId || where[0]?.id || '';
  const q = parseQuantity(qty);
  const req = useLoad<Requirements>(q && loc ? `/v1/manufacturing/requirements?bomId=${bomId}&quantity=${encodeURIComponent(q)}&locationId=${loc}` : null);
  const r = req.data;
  return (
    <section className="card" aria-label="Material check">
      <h2>Check material for a run</h2>
      <div className="form-grid">
        <Field label="Where"><select value={loc} onChange={(e) => setLocationId(e.target.value)}>{where.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>
        <Field label="How many to make" error={qty && !q ? 'A positive number' : null}><input inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} /></Field>
      </div>
      <ErrorBanner error={req.error} />
      {r && (
        <>
          {r.canRelease ? <Notice tone="ok">All material is free to reserve.</Notice>
            : r.fullyCoveredByOnOrder ? <Notice tone="warn">Short today, but open purchase orders will cover it.</Notice>
            : <Notice tone="warn">Short even after open purchase orders.</Notice>}
          <div className="table-wrap">
            <table>
              <thead><tr><th scope="col">Material</th><th scope="col" className="num">Needed</th><th scope="col" className="num">Free</th><th scope="col" className="num">Short</th><th scope="col" className="num">On order</th></tr></thead>
              <tbody>{r.lines.map((l) => <tr key={l.variantId}><th scope="row">{l.sku}</th><td className="num">{l.required}</td><td className="num">{l.available}</td><td className="num">{l.shortage}</td><td className="num">{l.onOrder}</td></tr>)}</tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
