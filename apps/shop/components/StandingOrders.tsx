'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { shopRequest } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { trimQty } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import type { Address, StandingOrder } from '@/lib/types';

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

/** On an order page: turn this order into one that repeats. Only offered to businesses with an approved trade account. */
export function RepeatOrder({ orderNo, paymentMethod }: { orderNo: string; paymentMethod: string }) {
  const { token } = useAuth();
  const { t } = useI18n();
  const [eligible, setEligible] = useState(false);
  const [addresses, setAddresses] = useState<Address[]>([]);
  const [addressId, setAddressId] = useState('');
  const [frequency, setFrequency] = useState<'weekly' | 'fortnightly' | 'monthly'>('weekly');
  const [first, setFirst] = useState(inDays(7));
  const [pay, setPay] = useState<'account' | 'bank_transfer'>(paymentMethod === 'bank_transfer' ? 'bank_transfer' : 'account');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');

  useEffect(() => {
    if (!token) return;
    shopRequest<{ status: string }>('/me/trade', { token }).then((a) => setEligible(a.status === 'approved')).catch(() => setEligible(false));
    shopRequest<Address[]>('/me/addresses', { token }).then((l) => { setAddresses(l); setAddressId(l.find((a) => a.isDefault)?.id ?? l[0]?.id ?? ''); }).catch(() => undefined);
  }, [token]);
  if (!eligible || !addresses.length) return null;

  const monthlyBad = frequency === 'monthly' && Number(first.slice(8, 10)) > 28;
  const create = async () => {
    if (!token) return;
    setBusy(true); setError(''); setDone('');
    try {
      const so = await shopRequest<StandingOrder>('/me/standing-orders', { token, body: { fromOrderNo: orderNo, addressId, frequency, firstRunOn: first, paymentMethod: pay } });
      setDone(t('standing.created', { date: so.nextRunOn }));
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <section className="card stack" aria-labelledby="repeat">
      <h2 id="repeat">{t('standing.repeat')}</h2>
      <p className="muted small">{t('standing.repeatText')}</p>
      <div className="grid2">
        <div className="field"><label htmlFor="so-freq">{t('standing.frequency')}</label>
          <select id="so-freq" value={frequency} onChange={(e) => setFrequency(e.target.value as typeof frequency)}>
            <option value="weekly">{t('standing.weekly')}</option><option value="fortnightly">{t('standing.fortnightly')}</option><option value="monthly">{t('standing.monthly')}</option>
          </select></div>
        <div className="field"><label htmlFor="so-first">{t('standing.firstOn')}</label><input id="so-first" type="date" min={inDays(0)} max={inDays(365)} value={first} onChange={(e) => setFirst(e.target.value)} /></div>
        <div className="field"><label htmlFor="so-addr">{t('standing.deliverTo')}</label>
          <select id="so-addr" value={addressId} onChange={(e) => setAddressId(e.target.value)}>{addresses.map((a) => <option key={a.id} value={a.id}>{a.label} — {a.line1}, {a.city}</option>)}</select></div>
        <div className="field"><label htmlFor="so-pay">{t('standing.payWith')}</label>
          <select id="so-pay" value={pay} onChange={(e) => setPay(e.target.value as typeof pay)}><option value="account">{t('standing.payAccount')}</option><option value="bank_transfer">{t('standing.payBank')}</option></select></div>
      </div>
      {monthlyBad && <p className="err" role="alert">{t('standing.monthlyDay')}</p>}
      {error && <p className="err" role="alert">{error}</p>}
      {done && <p className="ok" role="status">{done} <Link href="/trade">{t('standing.manage')}</Link></p>}
      <div><button className="btn" disabled={busy || !addressId || !first || monthlyBad} onClick={() => void create()}>{t('standing.create')}</button></div>
    </section>
  );
}

/** On the trade account page: every standing order, with pause, resume and cancel. */
export function StandingOrdersList() {
  const { token } = useAuth();
  const { t } = useI18n();
  const [list, setList] = useState<StandingOrder[] | null>(null);
  const [error, setError] = useState('');
  const load = () => { if (token) shopRequest<StandingOrder[]>('/me/standing-orders', { token }).then(setList).catch(() => setList([])); };
  useEffect(load, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (id: string, what: 'pause' | 'resume' | 'cancel') => {
    if (!token || (what === 'cancel' && !confirm(t('standing.confirmCancel')))) return;
    setError('');
    try { await shopRequest(`/me/standing-orders/${id}/${what}`, { token, method: 'POST' }); load(); } catch (e) { setError((e as Error).message); }
  };
  if (!list) return null;
  const shown = list.filter((s) => s.status !== 'cancelled');
  return (
    <>
      <h2>{t('standing.title')}</h2>
      {error && <p className="err" role="alert">{error}</p>}
      {shown.length === 0 ? <p className="muted">{t('standing.none')}</p> : (
        <ul className="plain" style={{ listStyle: 'none', padding: 0 }}>
          {shown.map((s) => (
            <li key={s.id} className="card" style={{ marginBottom: 12 }}>
              <div className="row spread"><strong>{t(`standing.every.${s.frequency}`)}</strong><span className="status">{t(`standing.status.${s.status}`)}</span></div>
              <p className="small muted" style={{ margin: '4px 0' }}>{s.lines.map((l) => `${l.title} × ${trimQty(l.quantity)}`).join(', ')}</p>
              <p className="small" style={{ margin: '4px 0' }}>{s.addressLabel}: {s.addressText}{s.status === 'active' ? ` · ${t('standing.next', { date: s.nextRunOn })}` : ''}</p>
              {s.lastRun && <p className="small muted" style={{ margin: '4px 0' }}>{s.lastRun.outcome === 'placed' ? t('standing.lastPlaced', { date: s.lastRun.runOn, order: s.lastRun.orderNo ?? '' }) : t('standing.lastFailed', { date: s.lastRun.runOn, reason: s.lastRun.reason ?? '' })}</p>}
              {s.status === 'paused' && s.pausedReason && <p className="small err">{s.pausedReason}</p>}
              <div className="row">
                {s.status === 'active' ? <button className="btn ghost small" onClick={() => void act(s.id, 'pause')}>{t('standing.pause')}</button> : <button className="btn small" onClick={() => void act(s.id, 'resume')}>{t('standing.resume')}</button>}
                <button className="btn ghost small" onClick={() => void act(s.id, 'cancel')}>{t('standing.cancel')}</button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
