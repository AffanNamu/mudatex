import { useMemo, useState, type FormEvent } from 'react';
import { ErrorBanner, Field, Loading, Notice, PageHeader } from '../components/ui';
import { api, newKey } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useLoad } from '../lib/hooks';
import { parseQuantity } from '../lib/money';
import type { Product } from './Catalogue';

interface Location { id: string; name: string; type: string; legalEntityId: string }
interface Balance { locationId: string; variantId: string; sku: string; productName: string; lotId: string | null; lotCode: string | null; quantity: string; reserved: string; available: string }

const HOLDS_STOCK = new Set(['branch', 'warehouse', 'storage_location']);

export function Inventory() {
  const { can } = useAuth();
  const locations = useLoad<Location[]>('/v1/locations');
  const products = useLoad<Product[]>(can('catalog.read') ? '/v1/products?limit=200' : null);
  const [locationId, setLocationId] = useState('');
  const where = useMemo(() => (locations.data ?? []).filter((l) => HOLDS_STOCK.has(l.type)), [locations.data]);
  const selected = locationId || where[0]?.id || '';
  const balances = useLoad<Balance[]>(selected ? `/v1/inventory/balances?locationId=${selected}` : null);

  const variants = useMemo(() => {
    const m = new Map<string, { name: string; sku: string; tracking: string }>();
    for (const p of products.data ?? []) for (const v of p.variants) m.set(v.id, { name: p.name, sku: v.sku, tracking: v.tracking });
    return m;
  }, [products.data]);

  return (
    <>
      <PageHeader title="Inventory" />
      <ErrorBanner error={locations.error ?? balances.error} />
      <div className="toolbar">
        <label className="field inline"><span className="field-label">Location</span>
          <select value={selected} onChange={(e) => setLocationId(e.target.value)} disabled={!where.length}>
            {where.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </label>
      </div>
      {!locations.loading && !where.length && <Notice>No stock-holding locations are visible to you.</Notice>}
      {selected && can('inventory.receive') && products.data && <Receive locationId={selected} variants={variants} onDone={() => { balances.reload(); }} />}
      {balances.loading ? <Loading what="stock" /> : selected && (
        <div className="table-wrap">
          <table>
            <caption className="sr-only">Stock at the selected location</caption>
            <thead><tr><th scope="col">Product</th><th scope="col">Lot / roll</th><th scope="col" className="num">On hand</th><th scope="col" className="num">Reserved</th><th scope="col" className="num">Available</th></tr></thead>
            <tbody>
              {(balances.data ?? []).filter((b) => b.quantity !== '0' || b.reserved !== '0').map((b) => {
                return (
                  <tr key={`${b.variantId}-${b.lotId}`}>
                    <th scope="row">{b.productName} ({b.sku})</th>
                    <td>{b.lotCode ?? '—'}</td>
                    <td className="num">{b.quantity}</td><td className="num">{b.reserved}</td><td className="num"><strong>{b.available}</strong></td>
                  </tr>
                );
              })}
              {!balances.data?.length && <tr><td colSpan={5} className="muted">No stock at this location.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function Receive({ locationId, variants, onDone }: { locationId: string; variants: Map<string, { name: string; sku: string; tracking: string }>; onDone(): void }) {
  const [variantId, setVariantId] = useState('');
  const [qty, setQty] = useState('');
  const [lotCode, setLotCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<string | null>(null);
  const [key, setKey] = useState(newKey);   // one key per intent: a retry of the same entry cannot double-count
  const list = [...variants.entries()];
  const v = variants.get(variantId || list[0]?.[0] || '');
  const chosen = variantId || list[0]?.[0] || '';
  const quantity = parseQuantity(qty);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!quantity) return;
    setBusy(true); setError(null); setDone(null);
    try {
      await api('/v1/inventory/receipts', { method: 'POST', idempotencyKey: key, body: { locationId, lines: [{ variantId: chosen, quantity, ...(v?.tracking !== 'none' && lotCode ? { lotCode } : {}) }] } });
      setDone(`Received ${quantity} × ${v?.name}.`); setQty(''); setLotCode(''); setKey(newKey()); onDone();
    } catch (err) { setError(err); }
    finally { setBusy(false); }
  };

  return (
    <details className="panel">
      <summary>Receive stock</summary>
      <form onSubmit={submit} className="form-grid">
        <Field label="Product">
          <select value={chosen} onChange={(e) => setVariantId(e.target.value)}>{list.map(([id, x]) => <option key={id} value={id}>{x.name} ({x.sku})</option>)}</select>
        </Field>
        <Field label="Quantity" error={qty && !quantity ? 'Enter a positive number' : null}>
          <input inputMode="decimal" value={qty} onChange={(e) => { setQty(e.target.value); setKey(newKey()); }} required />
        </Field>
        {v && v.tracking !== 'none' && <Field label={v.tracking === 'roll' ? 'Roll code' : 'Lot code'}><input value={lotCode} onChange={(e) => { setLotCode(e.target.value); setKey(newKey()); }} required /></Field>}
        <div className="form-actions"><button className="btn btn-primary" disabled={busy || !quantity}>{busy ? 'Receiving…' : 'Receive'}</button></div>
      </form>
      <ErrorBanner error={error} />
      {done && <Notice tone="ok">{done}</Notice>}
    </details>
  );
}
