'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { shopRequest } from '@/lib/api';
import { formatMoney, trimQty } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import type { Order } from '@/lib/types';

const REASONS = ['damaged', 'wrong_item', 'not_wanted', 'other'] as const;

/** Past return requests on a delivered order, and a form to ask for another. The store decides; the server checks the time limit and the quantities. */
export function ReturnRequest({ order, token, minorUnit, onChange }: { order: Order; token: string; minorUnit: number; onChange(o: Order): void }) {
  const { t } = useI18n();
  const [qty, setQty] = useState<Record<number, string>>({});
  const [reason, setReason] = useState<(typeof REASONS)[number]>('damaged');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);
  // One attempt keeps one key, so a double tap is one request.
  const key = useMemo(() => crypto.randomUUID(), [sent, error]);   // eslint-disable-line react-hooks/exhaustive-deps

  const held = (lineNo: number) => order.returns.filter((r) => ['requested', 'approved', 'received'].includes(r.status)).flatMap((r) => r.lines).filter((l) => l.lineNo === lineNo).reduce((n, l) => n + Number(l.quantity), 0);
  const room = (l: Order['lines'][number]) => Math.max(0, Number(l.quantity) - held(l.lineNo));
  const open = order.lines.filter((l) => room(l) > 0);
  const chosen = order.lines.filter((l) => Number(qty[l.lineNo]) > 0);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(''); setSent(false);
    try {
      onChange(await shopRequest<Order>(`/me/orders/${order.orderNo}/returns`, { token, key, body: { reason, ...(note.trim() ? { note: note.trim() } : {}), lines: chosen.map((l) => ({ lineNo: l.lineNo, quantity: String(qty[l.lineNo]) })) } }));
      setQty({}); setNote(''); setSent(true);
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  const withdraw = async (id: string) => {
    setBusy(true); setError('');
    try { await shopRequest(`/me/returns/${id}/cancel`, { method: 'POST', token }); onChange(await shopRequest<Order>(`/me/orders/${order.orderNo}`, { token })); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };

  if (order.status !== 'delivered' && order.returns.length === 0) return null;
  return (
    <section className="card stack" aria-labelledby="returns">
      <h2 id="returns">{t('ret.title')}</h2>
      {order.returns.length > 0 && (
        <ul className="plain">
          {order.returns.map((r) => (
            <li key={r.id}>
              <strong>{t(`ret.status.${r.status}`)}</strong> · {r.lines.map((l) => `${l.title} × ${trimQty(l.quantity)}`).join(', ')}
              {r.decisionNote && <div className="small muted">{r.decisionNote}</div>}
              {r.status === 'approved' && r.refundMinor > 0 && <div className="small">{t('ret.refund', { amount: formatMoney(r.refundMinor, order.currency, minorUnit) })}</div>}
              {r.status === 'requested' && <div><button className="btn ghost small" onClick={() => withdraw(r.id)} disabled={busy}>{t('ret.withdraw')}</button></div>}
            </li>
          ))}
        </ul>
      )}
      {order.status === 'delivered' && (open.length ? (
        <form className="stack" onSubmit={submit}>
          <h3>{t('ret.ask')}</h3>
          <p className="muted">{t('ret.intro')}</p>
          <fieldset className="stack"><legend>{t('ret.pick')}</legend>
            {open.map((l) => (
              <div className="field" key={l.lineNo}>
                <label htmlFor={`rq${l.lineNo}`}>{l.title} — {t('ret.qty')} (0–{trimQty(String(room(l)))})</label>
                <input id={`rq${l.lineNo}`} inputMode="decimal" value={qty[l.lineNo] ?? ''} onChange={(e) => setQty({ ...qty, [l.lineNo]: e.target.value })} pattern="\d+(\.\d{1,6})?" />
              </div>
            ))}
          </fieldset>
          <div className="field"><label htmlFor="rr">{t('ret.reason')}</label>
            <select id="rr" value={reason} onChange={(e) => setReason(e.target.value as (typeof REASONS)[number])}>{REASONS.map((r) => <option key={r} value={r}>{t(`ret.reason.${r}`)}</option>)}</select></div>
          <div className="field"><label htmlFor="rn">{t('ret.note')}</label><textarea id="rn" rows={3} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} /></div>
          {error && <p className="err" role="alert">{error}</p>}
          {sent && <p className="notice" role="status">{t('ret.sent')}</p>}
          <button className="btn" disabled={busy || chosen.length === 0}>{busy ? t('ret.sending') : t('ret.send')}</button>
        </form>
      ) : <p className="muted">{t('ret.noneLeft')}</p>)}
      {error && order.status !== 'delivered' && <p className="err" role="alert">{error}</p>}
    </section>
  );
}
