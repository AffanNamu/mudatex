'use client';

import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { RequireShopper } from '@/components/RequireShopper';
import { ApiError, shopRequest } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useCart } from '@/lib/cart';
import { formatMoney } from '@/lib/format';
import { T, useI18n } from '@/lib/i18n';
import type { QuoteRow, TradeAccount } from '@/lib/types';

function Trade() {
  const { token } = useAuth();
  const { store } = useCart();
  const { t } = useI18n();
  const money = (m: number) => formatMoney(m, store.currency, store.minorUnit);
  const [acct, setAcct] = useState<TradeAccount | null | undefined>(undefined);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [quotes, setQuotes] = useState<QuoteRow[]>([]);

  useEffect(() => {
    if (!token) return;
    shopRequest<TradeAccount>('/me/trade', { token }).then(setAcct).catch((e) => setAcct(e instanceof ApiError && e.status === 404 ? null : null));
    shopRequest<QuoteRow[]>('/me/quotes', { token }).then(setQuotes).catch(() => undefined);
  }, [token]);

  const apply = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true); setError('');
    try {
      setAcct(await shopRequest<TradeAccount>('/me/trade', { token: token!, body: { businessName: String(f.get('businessName')).trim(), ...(String(f.get('taxId')).trim() ? { taxId: String(f.get('taxId')).trim() } : {}) } }));
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };

  if (acct === undefined) return <p className="muted" role="status">{t('loading')}</p>;
  const form = (
    <form className="card stack" style={{ maxWidth: 520 }} onSubmit={apply}>
      <h2>{t('trade.apply')}</h2>
      <p className="muted">{t('trade.applyText')}</p>
      <div className="field"><label htmlFor="bn">{t('trade.business')}</label><input id="bn" name="businessName" required minLength={2} maxLength={150} autoComplete="organization" /></div>
      <div className="field"><label htmlFor="tin">{t('trade.taxId')}</label><input id="tin" name="taxId" maxLength={50} /></div>
      {error && <p className="err" role="alert">{error}</p>}
      <button className="btn" disabled={busy}>{busy ? t('sending') : t('trade.send')}</button>
    </form>
  );
  if (!acct) return form;
  return (
    <div className="stack">
      <div className="notice" role="status">
        <strong>{acct.businessName}</strong> — {acct.status === 'pending' ? t('trade.pending') : acct.status === 'approved' ? t('trade.approved') : acct.status === 'suspended' ? t('trade.suspended') : t('trade.rejected')}
        {acct.note && <> <span className="muted">{t('trade.note')} {acct.note}</span></>}
      </div>
      {acct.status === 'approved' && (
        <>
          <dl className="card summary" style={{ maxWidth: 520 }}>
            <dl>
              <dt>{t('trade.limit')}</dt><dd>{money(acct.creditLimitMinor)}</dd>
              <dt>{t('trade.owing')}</dt><dd>{money(acct.creditUsedMinor ?? 0)}</dd>
              <dt><strong>{t('trade.available')}</strong></dt><dd><strong>{money(acct.creditAvailableMinor ?? 0)}</strong></dd>
              <dt>{t('trade.terms')}</dt><dd>{t('trade.days', { n: acct.paymentTermsDays })}</dd>
            </dl>
          </dl>
          <p>{t('trade.autoPrices.pre')} <strong>{t('checkout.onAccount')}</strong> {t('trade.autoPrices.post')}</p>
          <h2>{t('quote.title')}</h2>
          {quotes.length ? (
            <table className="plain">
              <thead><tr><th>{t('quote.col.quote')}</th><th>{t('quote.col.valid')}</th><th style={{ textAlign: 'right' }}>{t('quote.col.goods')}</th><th>{t('quote.col.status')}</th></tr></thead>
              <tbody>{quotes.map((q) => (
                <tr key={q.quoteNo}><td><Link href={`/quotes/${q.quoteNo}`}>{q.quoteNo}</Link></td><td>{q.validUntil}</td><td style={{ textAlign: 'right' }}>{money(q.totalMinor)}</td><td>{t(`quote.status.${q.status}`)}</td></tr>
              ))}</tbody>
            </table>
          ) : <p className="muted">{t('quote.none')}</p>}
          <h2>{t('trade.statement')}</h2>
          {acct.statement?.length ? (
            <table className="plain">
              <thead><tr><th>{t('trade.col.date')}</th><th>{t('trade.col.entry')}</th><th style={{ textAlign: 'right' }}>{t('trade.col.amount')}</th><th style={{ textAlign: 'right' }}>{t('trade.col.balance')}</th></tr></thead>
              <tbody>{acct.statement.map((l, i) => (
                <tr key={i}><td>{new Date(l.at).toLocaleDateString()}</td><td>{l.kind === 'order' ? t('trade.entryOrder', { ref: l.reference }) : t('trade.entryPayment', { ref: l.reference })}</td>
                  <td style={{ textAlign: 'right' }}>{l.kind === 'order' ? money(l.amountMinor) : `−${money(l.amountMinor)}`}</td><td style={{ textAlign: 'right' }}>{money(l.balanceMinor)}</td></tr>
              ))}</tbody>
            </table>
          ) : <p className="muted">{t('trade.noOrders')}</p>}
        </>
      )}
      {acct.status === 'rejected' && form}
    </div>
  );
}

export default function TradePage() {
  return <div className="wrap section"><h1><T k="trade.title" /></h1><RequireShopper><Trade /></RequireShopper></div>;
}
