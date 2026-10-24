import { useRef, useState } from 'react';
import { ErrorBanner, Field, Loading, Notice } from '../../components/ui';
import { api, newKey } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useLoad } from '../../lib/hooks';

interface Lot { id: string; sku: string; productName: string; kind: string; code: string; initialQuantity: string; holdStatus: 'released' | 'quarantined'; holdReason: string | null; heldBy: string | null }

/** A lot or roll on hold cannot be sold, issued or transferred. A different person releases it than the one who held it. */
export function Quality() {
  const { can, session } = useAuth();
  const lots = useLoad<Lot[]>('/v1/inventory/lots');
  const [onlyHeld, setOnlyHeld] = useState(false);
  const [acting, setActing] = useState<{ lot: Lot; action: 'hold' | 'release' } | null>(null);
  const shown = (lots.data ?? []).filter((l) => !onlyHeld || l.holdStatus === 'quarantined');

  return (
    <>
      <div className="toolbar">
        <label className="chip"><input type="checkbox" checked={onlyHeld} onChange={(e) => setOnlyHeld(e.target.checked)} /> Only lots on hold</label>
      </div>
      <ErrorBanner error={lots.error} />
      {lots.loading && !lots.data ? <Loading what="lots" /> : (
        <div className="table-wrap">
          <table>
            <caption className="sr-only">Lots and rolls</caption>
            <thead><tr><th scope="col">Lot / roll</th><th scope="col">Product</th><th scope="col" className="num">Initial qty</th><th scope="col">Status</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {shown.map((l) => (
                <tr key={l.id}>
                  <th scope="row">{l.code}</th>
                  <td>{l.productName} <span className="muted">({l.sku})</span></td>
                  <td className="num">{l.initialQuantity}</td>
                  <td>{l.holdStatus === 'quarantined' ? <>On hold<span className="muted"> · {l.holdReason}</span></> : 'Available'}</td>
                  <td>
                    {l.holdStatus === 'released' && can('quality.hold') && <button type="button" className="btn btn-ghost" onClick={() => setActing({ lot: l, action: 'hold' })} aria-label={`Hold ${l.code}`}>Hold</button>}
                    {l.holdStatus === 'quarantined' && can('quality.release') && (
                      l.heldBy === session?.user.id
                        ? <span className="muted">You held it</span>
                        : <button type="button" className="btn btn-ghost" onClick={() => setActing({ lot: l, action: 'release' })} aria-label={`Release ${l.code}`}>Release</button>
                    )}
                  </td>
                </tr>
              ))}
              {!shown.length && <tr><td colSpan={5} className="muted">{onlyHeld ? 'Nothing is on hold.' : 'No lots or rolls yet.'}</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      {acting && <Decision key={`${acting.lot.id}${acting.action}`} {...acting} onClose={() => setActing(null)} onDone={() => { setActing(null); lots.reload(); }} />}
    </>
  );
}

function Decision({ lot, action, onClose, onDone }: { lot: Lot; action: 'hold' | 'release'; onClose(): void; onDone(): void }) {
  const [text, setText] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const key = useRef(newKey());
  const min = action === 'hold' ? 5 : 3;
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await api(`/v1/quality/lots/${lot.id}/${action}`, { method: 'POST', idempotencyKey: key.current, body: action === 'hold' ? { reason: text.trim() } : { note: text.trim() } });
      onDone();
    } catch (err) { setError(err); setBusy(false); }
  }
  return (
    <form className="card" onSubmit={submit} aria-label={`${action === 'hold' ? 'Hold' : 'Release'} ${lot.code}`}>
      <h2>{action === 'hold' ? 'Put on hold' : 'Release'}: {lot.code}</h2>
      {action === 'hold' ? <Notice tone="warn">Stock in this lot cannot be sold, issued or moved until it is released by someone else.</Notice> : <p className="muted">Held because: {lot.holdReason}</p>}
      <Field label={action === 'hold' ? 'Reason' : 'Inspection note'} error={text && text.trim().length < min ? `At least ${min} characters` : null}>
        <input value={text} onChange={(e) => { setText(e.target.value); key.current = newKey(); }} maxLength={500} autoFocus />
      </Field>
      <ErrorBanner error={error} />
      <div className="row-end">
        <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || text.trim().length < min}>{action === 'hold' ? 'Put on hold' : 'Release lot'}</button>
      </div>
    </form>
  );
}
