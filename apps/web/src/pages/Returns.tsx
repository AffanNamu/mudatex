import { useRef, useState, type FormEvent } from 'react';
import { ErrorBanner, Field, Notice, PageHeader } from '../components/ui';
import { api, newKey } from '../lib/api';
import { formatMoney, parseQuantity } from '../lib/money';

interface SaleLine { id: string; lineNo: number; productName: string; sku: string; quantity: string; returnedQuantity: string; totalMinor: number }
interface Sale {
  id: string; receiptNumber: string; status: string; currency: string; minorUnit: number; totalMinor: number;
  lines: SaleLine[]; payments: { method: string; status: string }[];
}
interface Return { returnNumber: string; refundMethod: string; refundTotalMinor: number; refundStatus: string }

const left = (l: SaleLine) => String(Number(l.quantity) - Number(l.returnedQuantity));

/** Takes goods back against a receipt. The server works out the refund; this screen only says what is coming back. */
export function Returns() {
  const [receipt, setReceipt] = useState('');
  const [sale, setSale] = useState<Sale | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [searching, setSearching] = useState(false);
  const [done, setDone] = useState<{ ret: Return; currency: string; minorUnit: number } | null>(null);

  async function find(e: FormEvent) {
    e.preventDefault();
    setSearching(true); setError(null); setSale(null); setDone(null);
    try {
      const hits = await api<{ id: string }[]>(`/v1/pos/sales?receipt=${encodeURIComponent(receipt.trim())}`);
      if (!hits[0]) throw new Error(`No sale with receipt ${receipt.trim()} that you can see.`);
      setSale(await api<Sale>(`/v1/pos/sales/${hits[0].id}`));
    } catch (err) { setError(err); }
    finally { setSearching(false); }
  }

  return (
    <>
      <PageHeader title="Returns" />
      <form className="card" onSubmit={find}>
        <Field label="Receipt number" hint="For example LAG1-000042">
          <input value={receipt} onChange={(e) => setReceipt(e.target.value)} autoFocus />
        </Field>
        <button className="btn btn-primary" disabled={searching || !receipt.trim()}>Find sale</button>
      </form>
      <ErrorBanner error={error} />
      {done && (
        <Notice tone="ok">
          Return {done.ret.returnNumber} recorded. Refund {formatMoney(done.ret.refundTotalMinor, done.currency, done.minorUnit)} by {done.ret.refundMethod.replace('_', ' ')}
          {done.ret.refundStatus === 'pending_disbursement' ? ' — a supervisor must confirm the payout.' : ' — hand the cash back from the drawer.'}
        </Notice>
      )}
      {sale && !done && (sale.status !== 'completed'
        ? <Notice tone="warn">Sale {sale.receiptNumber} is {sale.status.replace('_', ' ')}; only completed sales can be returned.</Notice>
        : <ReturnForm key={sale.id} sale={sale} onDone={(ret) => { setDone({ ret, currency: sale.currency, minorUnit: sale.minorUnit }); setSale(null); }} />)}
    </>
  );
}

function ReturnForm({ sale, onDone }: { sale: Sale; onDone(r: Return): void }) {
  const methods = [...new Set(sale.payments.filter((p) => p.status === 'confirmed').map((p) => p.method))];
  const [qty, setQty] = useState<Record<string, string>>({});
  const [restock, setRestock] = useState<Record<string, boolean>>({});
  const [method, setMethod] = useState(methods[0] ?? 'cash');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  // The key follows the content of the request: changing it after a failure is a new intent.
  const key = useRef(newKey());

  const picked = sale.lines.filter((l) => qty[l.id]?.trim());
  const bad = (l: SaleLine) => { const q = parseQuantity(qty[l.id] ?? ''); return !q || Number(q) > Number(left(l)); };
  const invalid = picked.length === 0 || picked.some(bad) || reason.trim().length < 5;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (invalid) return;
    setBusy(true); setError(null);
    try {
      onDone(await api<Return>(`/v1/pos/sales/${sale.id}/returns`, {
        method: 'POST', idempotencyKey: key.current,
        body: { reason: reason.trim(), refund: { method }, lines: picked.map((l) => ({ saleLineId: l.id, quantity: qty[l.id]!.trim(), restock: restock[l.id] ?? true })) },
      }));
    } catch (err) { setError(err); setBusy(false); }
  }
  const touch = () => { key.current = newKey(); };

  return (
    <form className="card" onSubmit={submit}>
      <h2>Sale {sale.receiptNumber} · {formatMoney(sale.totalMinor, sale.currency, sale.minorUnit)}</h2>
      <div className="table-wrap">
        <table>
          <thead><tr><th scope="col">Item</th><th scope="col" className="num">Sold</th><th scope="col" className="num">Already returned</th><th scope="col">Return qty</th><th scope="col">Back on shelf</th></tr></thead>
          <tbody>
            {sale.lines.map((l) => (
              <tr key={l.id}>
                <th scope="row">{l.productName}<br /><span className="muted">{l.sku}</span></th>
                <td className="num">{l.quantity}</td>
                <td className="num">{l.returnedQuantity}</td>
                <td><input className="narrow" inputMode="decimal" aria-label={`Return quantity for ${l.productName}`} aria-invalid={!!qty[l.id]?.trim() && bad(l)} disabled={left(l) === '0'}
                  value={qty[l.id] ?? ''} onChange={(e) => { setQty({ ...qty, [l.id]: e.target.value }); touch(); }} /></td>
                <td><input type="checkbox" aria-label={`Resaleable: ${l.productName}`} checked={restock[l.id] ?? true} onChange={(e) => { setRestock({ ...restock, [l.id]: e.target.checked }); touch(); }} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="form-grid">
        <Field label="Refund by" hint="Only a way the customer originally paid.">
          <select value={method} onChange={(e) => { setMethod(e.target.value); touch(); }}>{methods.map((m) => <option key={m} value={m}>{m.replace('_', ' ')}</option>)}</select>
        </Field>
        <Field label="Reason" error={reason && reason.trim().length < 5 ? 'At least 5 characters' : null}>
          <input value={reason} onChange={(e) => { setReason(e.target.value); touch(); }} maxLength={1000} />
        </Field>
      </div>
      <ErrorBanner error={error} />
      <button className="btn btn-primary" disabled={busy || invalid}>{busy ? 'Working…' : 'Record return'}</button>
    </form>
  );
}
