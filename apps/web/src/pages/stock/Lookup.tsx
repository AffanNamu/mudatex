import { useState } from 'react';
import { Notice } from '../../components/ui';
import { ScanBox } from '../../components/ScanBox';
import { api } from '../../lib/api';
import { ageMinutes, findByCode, searchItems, type SheetItem } from '../../lib/stockSheet';
import type { Stock } from '../../lib/useStock';

/** What is on the shelf here: live from the server when online, from the phone's copy (with its age) when not. */
export function Lookup({ stock }: { stock: Stock }) {
  const { sheet, locationId } = stock;
  const [shown, setShown] = useState<SheetItem[]>([]);
  const [fromPhone, setFromPhone] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const show = async (code: string) => {
    setMessage(null);
    try {
      const live = await api<SheetItem[]>(`/v1/inventory/lookup?locationId=${locationId}&code=${encodeURIComponent(code)}`);
      setFromPhone(false); setShown(live);
      if (!live.length) setMessage(`Nothing matches "${code}".`);
    } catch {
      const local = findByCode(sheet, code);
      setFromPhone(true); setShown(local);
      if (!local.length) setMessage(sheet ? `Nothing on this phone's list matches "${code}".` : 'No connection, and no stock list on this phone yet.');
    }
  };
  const matches = searchItems(sheet, search);

  return (
    <section className="stock-section">
      <ScanBox onCode={(c) => void show(c)} label="Scan or type a barcode / SKU" />
      <label className="field"><span className="field-label">Or search by name</span><input type="search" value={search} onChange={(e) => setSearch(e.target.value)} autoComplete="off" /></label>
      {matches.length > 0 && <ul className="stock-results" aria-label="Matches">{matches.map((i) => <li key={i.variantId}><button type="button" className="btn" onClick={() => { setShown([i]); setFromPhone(true); setSearch(''); setMessage(null); }}>{i.productName} <span className="muted">{i.sku}</span></button></li>)}</ul>}
      {message && <Notice tone="warn">{message}</Notice>}
      {fromPhone && shown.length > 0 && sheet && <Notice>From the copy on this phone, {ageMinutes(sheet.generatedAt)} min old.</Notice>}
      {shown.map((i) => (
        <article key={i.variantId} className="card stock-card" aria-label={i.productName}>
          <h2>{i.productName}</h2>
          <p className="muted small">{i.sku}{i.barcodes?.[0] ? ` · ${i.barcodes[0]}` : ''}{(i as { barcode?: string }).barcode ? ` · ${(i as { barcode?: string }).barcode}` : ''} · counted in {i.unit}</p>
          {i.balances.length === 0 ? <p>None on the shelf here.</p> : (
            <table>
              <thead><tr><th scope="col">{i.tracking === 'none' ? 'Stock' : i.tracking === 'roll' ? 'Roll' : 'Lot'}</th><th scope="col" className="num">On hand</th><th scope="col" className="num">Reserved</th><th scope="col" className="num">Free</th></tr></thead>
              <tbody>{i.balances.map((b) => <tr key={b.lotId ?? 'none'}><th scope="row">{b.lotCode ?? 'All'}{b.quarantined ? ' (on hold)' : ''}</th><td className="num">{b.quantity}</td><td className="num">{b.reserved}</td><td className="num"><strong>{b.available}</strong></td></tr>)}</tbody>
            </table>
          )}
        </article>
      ))}
    </section>
  );
}
