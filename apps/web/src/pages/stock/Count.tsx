import { useCallback, useEffect, useRef, useState } from 'react';
import { Notice } from '../../components/ui';
import { ScanBox } from '../../components/ScanBox';
import { clearDraft, loadDraft, saveDraft, type DraftRow } from '../../lib/stockStore';
import { findByCode, plusOne, quantityFor, searchItems, type SheetItem } from '../../lib/stockSheet';
import type { Stock } from '../../lib/useStock';
import { Outcome } from './Outcome';

const rowKey = (r: { variantId: string; lotId: string | null }) => `${r.variantId}/${r.lotId ?? ''}`;

/**
 * Count the shelf without seeing what the books say (so the count is honest). Only what you count is compared; anything
 * you skip is left alone. Differences go to a second person to approve — nothing changes stock from here.
 */
export function Count({ stock, userId }: { stock: Stock; userId: string }) {
  const { sheet, locationId } = stock;
  const [rows, setRows] = useState<DraftRow[]>([]);
  const [note, setNote] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const focus = useRef<string | null>(null);
  const byVariant = new Map((sheet?.items ?? []).map((i) => [i.variantId, i]));

  // A count in progress survives a refresh, a lock screen and a dead battery.
  useEffect(() => {
    let live = true;
    loadDraft(locationId).then((d) => { if (live && d && d.userId === userId) { setRows(d.rows); setNote(d.note); } }).catch(() => undefined).finally(() => live && setLoaded(true));
    return () => { live = false; };
  }, [locationId, userId]);
  useEffect(() => {
    if (!loaded) return;
    if (!rows.length && !note) void clearDraft(locationId);
    else void saveDraft({ locationId, userId, rows, note });
  }, [rows, note, loaded, locationId, userId]);
  useEffect(() => {
    if (focus.current) { document.getElementById(`count-${focus.current}`)?.focus(); focus.current = null; }
  });

  const add = useCallback((item: SheetItem, fromScan: boolean) => {
    setMessage(null); setSubmitted(null);
    if (item.tracking === 'none') {
      const key = rowKey({ variantId: item.variantId, lotId: null });
      const step = fromScan && item.unitKind === 'discrete';
      setRows((cur) => {
        const at = cur.findIndex((r) => rowKey(r) === key);
        if (at >= 0) return step ? cur.map((r, i) => (i === at ? { ...r, counted: plusOne(r.counted) } : r)) : cur;
        return [...cur, { variantId: item.variantId, lotId: null, counted: step ? '1' : '' }];
      });
      focus.current = key;
    } else {
      const lots = item.balances.filter((b) => b.lotId);
      if (!lots.length) { setMessage(`No ${item.tracking} of ${item.productName} is on record here. Receive it first.`); return; }
      setRows((cur) => [...cur, ...lots.filter((b) => !cur.some((r) => r.variantId === item.variantId && r.lotId === b.lotId)).map((b) => ({ variantId: item.variantId, lotId: b.lotId, counted: '' }))]);
      focus.current = rowKey({ variantId: item.variantId, lotId: lots[0]!.lotId });
    }
  }, []);

  const onCode = (code: string) => {
    if (!sheet) { setMessage('The stock list is not on this phone yet. Connect once and press Refresh.'); return; }
    const found = findByCode(sheet, code);
    if (!found.length) { setMessage(`Nothing in the stock list matches "${code}".`); return; }
    add(found[0]!, true);
  };

  const results = searchItems(sheet, search);
  const set = (key: string, counted: string) => setRows((cur) => cur.map((r) => (rowKey(r) === key ? { ...r, counted } : r)));
  const problems = rows.filter((r) => { const it = byVariant.get(r.variantId); return !it || quantityFor(r.counted, it, true) === null; });

  const send = async () => {
    const queued = await stock.submit({
      kind: 'count', path: '/v1/inventory/counts',
      label: `Count of ${rows.length} ${rows.length === 1 ? 'line' : 'lines'} at ${stock.location?.name ?? 'a place'}`,
      body: { locationId, note: note.trim() || undefined, countedAt: new Date().toISOString(), lines: rows.map((r) => ({ variantId: r.variantId, ...(r.lotId ? { lotId: r.lotId } : {}), counted: r.counted.trim() })) },
    });
    setSubmitted(queued.id); setRows([]); setNote(''); await clearDraft(locationId);
  };

  return (
    <section className="stock-section">
      <ScanBox onCode={onCode} label="Scan or type a barcode / SKU" />
      <label className="field">
        <span className="field-label">Or search by name</span>
        <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} autoComplete="off" />
      </label>
      {results.length > 0 && (
        <ul className="stock-results" aria-label="Matches">
          {results.map((i) => <li key={i.variantId}><button type="button" className="btn" onClick={() => { add(i, false); setSearch(''); }}>{i.productName} <span className="muted">{i.sku}</span></button></li>)}
        </ul>
      )}
      {message && <Notice tone="warn">{message}</Notice>}
      <Outcome stock={stock} id={submitted} kind="count" />

      {rows.length === 0 && !submitted && <p className="muted">Scan or search for what is on the shelf, then type how many you count. Items you do not scan are not changed.</p>}
      <ul className="stock-rows">
        {rows.map((r) => {
          const it = byVariant.get(r.variantId);
          const lot = it?.balances.find((b) => b.lotId === r.lotId);
          const key = rowKey(r);
          const bad = r.counted !== '' && !!it && quantityFor(r.counted, it, true) === null;
          return (
            <li key={key} className="stock-row">
              <div className="stock-row-name"><strong>{it?.productName ?? 'Unknown product'}</strong><span className="muted small">{it?.sku}{lot?.lotCode ? ` · ${it?.tracking === 'roll' ? 'roll' : 'lot'} ${lot.lotCode}` : ''}{lot?.quarantined ? ' · on hold' : ''}</span></div>
              <label className="stock-qty">
                <span className="sr-only">Counted {it?.productName} {lot?.lotCode ?? ''}</span>
                <input id={`count-${key}`} inputMode="decimal" value={r.counted} onChange={(e) => set(key, e.target.value)} aria-invalid={bad} placeholder="0" />
                <span className="muted small">{it?.unit}</span>
              </label>
              <button type="button" className="btn btn-ghost" onClick={() => setRows((cur) => cur.filter((x) => rowKey(x) !== key))} aria-label={`Remove ${it?.productName ?? 'row'}`}>✕</button>
              {bad && <span className="field-error">{it!.unitKind === 'discrete' ? 'Whole numbers only' : `Up to ${it!.precision} decimal places`}</span>}
            </li>
          );
        })}
      </ul>

      {rows.length > 0 && (
        <div className="stock-submit">
          <label className="field"><span className="field-label">Note (optional)</span><input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="e.g. Aisle 3, end of day" /></label>
          {problems.length > 0 && <p className="small muted">Type a number for every row (0 is fine if you found none), or remove the row.</p>}
          <button type="button" className="btn btn-primary btn-lg" disabled={problems.length > 0} onClick={() => void send()}>Send count ({rows.length})</button>
        </div>
      )}
    </section>
  );
}
