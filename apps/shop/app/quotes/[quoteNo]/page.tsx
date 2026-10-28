'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { RequireShopper } from '@/components/RequireShopper';
import { shopRequest } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatMoney, trimQty } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import type { Address, Quote } from '@/lib/types';

function QuoteView() {
  const { quoteNo } = useParams<{ quoteNo: string }>();
  const { token } = useAuth();
  const { t } = useI18n();
  const router = useRouter();
  const [quote, setQuote] = useState<Quote | null>(null);
  const [missing, setMissing] = useState(false);
  const [addresses, setAddresses] = useState<Address[]>([]);
  const [addressId, setAddressId] = useState('');
  const [method, setMethod] = useState<'account' | 'bank_transfer'>('account');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const attempt = useRef<{ sig: string; key: string } | null>(null);

  useEffect(() => {
    if (!token) return;
    shopRequest<Quote>(`/me/quotes/${quoteNo}`, { token }).then(setQuote).catch(() => setMissing(true));
    shopRequest<Address[]>('/me/addresses', { token }).then((list) => { setAddresses(list); setAddressId(list.find((a) => a.isDefault)?.id ?? list[0]?.id ?? ''); }).catch(() => undefined);
  }, [token, quoteNo]);

  if (missing) return <div className="empty"><h1>{t('quote.notFound')}</h1><Link className="btn" href="/trade">{t('quote.back')}</Link></div>;
  if (!quote) return <p className="muted" role="status">{t('loading')}</p>;
  const money = (m: number) => formatMoney(m, quote.currency, quote.minorUnit);
  const open = quote.status === 'sent';

  const accept = async () => {
    if (!token || !addressId) return;
    // One key per distinct choice, so a double tap or a retry on a bad connection places one order.
    const sig = JSON.stringify([quote.quoteNo, addressId, method]);
    if (attempt.current?.sig !== sig) attempt.current = { sig, key: crypto.randomUUID() };
    setBusy(true); setError('');
    try {
      const order = await shopRequest<{ orderNo: string }>(`/me/quotes/${quote.quoteNo}/accept`, { token, key: attempt.current.key, body: { addressId, paymentMethod: method } });
      router.push(`/orders/${order.orderNo}?placed=1`);
    } catch (e) { setError((e as Error).message); setBusy(false); }
  };
  const decline = async () => {
    if (!token || !confirm(t('quote.confirmDecline'))) return;
    setBusy(true); setError('');
    try { setQuote({ ...quote, ...(await shopRequest<Quote>(`/me/quotes/${quote.quoteNo}/decline`, { token, method: 'POST' })) }); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="stack">
      <div className="row spread"><h1 style={{ margin: 0 }}>{t('quote.heading', { no: quote.quoteNo })}</h1><span className="status">{t(`quote.status.${quote.status}`)}</span></div>
      <p className="muted">{quote.businessName}{open ? ` · ${t('quote.validUntil', { date: quote.validUntil })}` : ''}</p>
      {quote.note && <p className="notice"><strong>{t('quote.note')}</strong> {quote.note}</p>}
      <table className="plain">
        <thead><tr><th>{t('quote.col.product')}</th><th style={{ textAlign: 'right' }}>{t('quote.col.qty')}</th><th style={{ textAlign: 'right' }}>{t('quote.col.price')}</th><th style={{ textAlign: 'right' }}>{t('quote.col.total')}</th></tr></thead>
        <tbody>
          {quote.lines.map((l) => (
            <tr key={l.lineNo}><td>{l.title}<div className="small muted">{l.sku}</div></td><td style={{ textAlign: 'right' }}>{trimQty(l.quantity)}</td><td style={{ textAlign: 'right' }}>{trimQty(l.unitPrice)}</td><td style={{ textAlign: 'right' }}>{money(l.totalMinor)}</td></tr>
          ))}
          <tr><td colSpan={3}><strong>{t('quote.goods')}</strong></td><td style={{ textAlign: 'right' }}><strong>{money(quote.subtotalMinor)}</strong></td></tr>
        </tbody>
      </table>
      <p className="small muted">{t('quote.deliveryNote')}</p>

      {!open && <p className="notice" role="status">{t('quote.closed', { status: t(`quote.status.${quote.status}`).toLowerCase() })}{quote.orderNo ? <> {t('quote.becameOrder')} <Link href={`/orders/${quote.orderNo}`}>{quote.orderNo}</Link>.</> : null}</p>}

      {open && (
        <section className="card stack" aria-label={t('quote.accept')}>
          {addresses.length === 0 ? (
            <p>{t('quote.noAddress')} <Link href="/account/addresses">{t('quote.addAddress')}</Link></p>
          ) : (
            <div className="field"><label htmlFor="q-addr">{t('quote.deliverTo')}</label>
              <select id="q-addr" value={addressId} onChange={(e) => setAddressId(e.target.value)}>
                {addresses.map((a) => <option key={a.id} value={a.id}>{a.label} — {a.line1}, {a.city}, {a.state}</option>)}
              </select>
            </div>
          )}
          <fieldset style={{ border: 0, padding: 0 }}>
            <legend className="small" style={{ fontWeight: 600 }}>{t('quote.payWith')}</legend>
            <label className="radio"><input type="radio" name="qpay" checked={method === 'account'} onChange={() => setMethod('account')} /> <span>{t('quote.payAccount')}</span></label>
            <label className="radio"><input type="radio" name="qpay" checked={method === 'bank_transfer'} onChange={() => setMethod('bank_transfer')} /> <span>{t('quote.payBank')}</span></label>
          </fieldset>
          {error && <p className="err" role="alert">{error}</p>}
          <div className="row">
            <button className="btn" disabled={busy || !addressId} onClick={() => void accept()}>{busy ? t('quote.accepting') : t('quote.accept')}</button>
            <button className="btn ghost" disabled={busy} onClick={() => void decline()}>{t('quote.decline')}</button>
          </div>
        </section>
      )}
    </div>
  );
}

export default function QuotePage() {
  return <div className="wrap section"><RequireShopper><QuoteView /></RequireShopper></div>;
}
