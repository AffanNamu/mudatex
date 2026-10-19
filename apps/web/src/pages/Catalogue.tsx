import { useMemo, useState, type FormEvent } from 'react';
import { ErrorBanner, Field, Loading, Notice, PageHeader } from '../components/ui';
import { ApiError, api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useLoad } from '../lib/hooks';

export interface Unit { id: string; code: string; name: string; kind: string; precision: number }
export interface Product {
  id: string; name: string; category: string | null; baseUnitId: string; status: string;
  variants: { id: string; sku: string; tracking: 'none' | 'lot' | 'roll'; barcodes: string[] }[];
}

export function Catalogue() {
  const { canEverywhere } = useAuth();
  const products = useLoad<Product[]>('/v1/products?limit=200');
  const units = useLoad<Unit[]>('/v1/units');
  const [q, setQ] = useState('');
  const unitById = useMemo(() => new Map((units.data ?? []).map((u) => [u.id, u])), [units.data]);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (products.data ?? []).filter((p) => !needle || p.name.toLowerCase().includes(needle) || p.variants.some((v) => v.sku.toLowerCase().includes(needle)));
  }, [products.data, q]);

  return (
    <>
      <PageHeader title="Catalogue" />
      <ErrorBanner error={products.error ?? units.error} />
      {canEverywhere('catalog.write') && units.data && <NewProduct units={units.data} onCreated={products.reload} />}
      <div className="toolbar">
        <label className="field inline"><span className="field-label">Search</span>
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name or SKU" />
        </label>
      </div>
      {products.loading ? <Loading what="products" /> : (
        <div className="table-wrap">
          <table>
            <caption className="sr-only">Products</caption>
            <thead><tr><th scope="col">Product</th><th scope="col">Category</th><th scope="col">Unit</th><th scope="col">SKUs</th></tr></thead>
            <tbody>
              {shown.map((p) => (
                <tr key={p.id}>
                  <th scope="row">{p.name}</th>
                  <td>{p.category ?? '—'}</td>
                  <td>{unitById.get(p.baseUnitId)?.code ?? '—'}</td>
                  <td>{p.variants.map((v) => <span key={v.id} className="chip">{v.sku}{v.tracking !== 'none' ? ` · ${v.tracking}` : ''}</span>)}</td>
                </tr>
              ))}
              {!shown.length && <tr><td colSpan={4} className="muted">No products{q ? ' match your search' : ' yet'}.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function NewProduct({ units, onCreated }: { units: Unit[]; onCreated(): void }) {
  const [name, setName] = useState('');
  const [sku, setSku] = useState('');
  const [unitId, setUnitId] = useState('');
  const [tracking, setTracking] = useState('none');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null); setDone(null);
    try {
      await api('/v1/products', { method: 'POST', body: { name: name.trim(), baseUnitId: unitId || units[0]?.id, variants: [{ sku: sku.trim(), tracking }] } });
      setDone(name.trim()); setName(''); setSku(''); onCreated();
    } catch (err) { setError(err instanceof ApiError && err.status === 409 ? new Error('That SKU already exists.') : err); }
    finally { setBusy(false); }
  };

  return (
    <details className="panel">
      <summary>New product</summary>
      <form onSubmit={submit} className="form-grid">
        <Field label="Name"><input required value={name} onChange={(e) => setName(e.target.value)} maxLength={300} /></Field>
        <Field label="SKU"><input required value={sku} onChange={(e) => setSku(e.target.value)} maxLength={100} /></Field>
        <Field label="Unit of measure">
          <select value={unitId || units[0]?.id} onChange={(e) => setUnitId(e.target.value)}>{units.map((u) => <option key={u.id} value={u.id}>{u.name} ({u.code})</option>)}</select>
        </Field>
        <Field label="Tracking" hint="Rolls and lots are identified individually in stock.">
          <select value={tracking} onChange={(e) => setTracking(e.target.value)}><option value="none">None</option><option value="lot">Lot</option><option value="roll">Roll</option></select>
        </Field>
        <div className="form-actions"><button className="btn btn-primary" disabled={busy || !name || !sku}>{busy ? 'Saving…' : 'Create product'}</button></div>
      </form>
      <ErrorBanner error={error} />
      {done && <Notice tone="ok">Created “{done}”.</Notice>}
    </details>
  );
}
