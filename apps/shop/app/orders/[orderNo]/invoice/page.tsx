'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { RequireShopper } from '@/components/RequireShopper';
import { shopRequest } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatMoney, trimQty } from '@/lib/format';
import { useI18n } from '@/lib/i18n';

interface Doc {
  orderNo: string; status: string; issuedOn: string; dueOn: string | null; currency: string; minorUnit: number; paymentMethod: string;
  seller: { name: string; legalName: string; address: string | null; phone: string | null; email: string | null; taxId: string | null; footer: string | null };
  buyer: { name: string; email: string; phone: string | null; businessName: string | null; taxId: string | null };
  deliveryTo: { recipient: string; line1: string; line2: string | null; city: string; state: string; countryCode: string };
  lines: { title: string; sku: string; quantity: string; unitPrice: string; taxCode: string | null; taxRatePct: string | null; discountMinor: number; taxMinor: number; totalMinor: number }[];
  taxSummary: { taxCode: string; ratePct: string; taxableMinor: number; taxMinor: number }[];
  goodsMinor: number; discountMinor: number; couponCode: string | null; deliveryFeeMinor: number; totalMinor: number;
  payments: { at: string; method: string; reference: string; amountMinor: number }[];
  refunds: { at: string; method: string; amountMinor: number }[];
  paidMinor: number; refundedMinor: number; balanceMinor: number;
  bank: { bankName: string | null; accountName: string | null; accountNumber: string | null } | null;
}

function InvoiceView() {
  const { orderNo } = useParams<{ orderNo: string }>();
  const { token } = useAuth();
  const { t, lang } = useI18n();
  const [doc, setDoc] = useState<Doc | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => { if (token) shopRequest<Doc>(`/me/orders/${orderNo}/document`, { token }).then(setDoc).catch(() => setMissing(true)); }, [token, orderNo]);
  if (missing) return <div className="empty"><h1>{t('order.notFound')}</h1><Link className="btn" href="/account/orders">{t('order.yourOrders')}</Link></div>;
  if (!doc) return <p className="muted" role="status">{t('loading')}</p>;

  const m = (n: number) => formatMoney(n, doc.currency, doc.minorUnit);
  const cancelled = doc.status === 'cancelled' || doc.status === 'expired';
  const title = cancelled ? t('doc.cancelled') : doc.paidMinor > 0 && doc.balanceMinor === 0 ? t('doc.receipt') : t('doc.invoice');
  const day = (iso: string) => new Date(iso).toLocaleDateString(lang);

  return (
    <article className="doc" aria-label={`${title} ${doc.orderNo}`}>
      <div className="doc-actions no-print">
        <Link className="btn ghost small" href={`/orders/${doc.orderNo}`}>← {t('doc.back')}</Link>
        <button className="btn small" onClick={() => window.print()}>{t('doc.print')}</button>
      </div>
      <header className="doc-head">
        <div>
          <h1>{title}</h1>
          <p>{t('doc.orderNo', { no: doc.orderNo })}<br />{t('doc.date', { date: day(doc.issuedOn) })}{doc.dueOn && doc.balanceMinor > 0 ? <><br />{t('doc.dueOn', { date: day(doc.dueOn) })}</> : null}</p>
        </div>
        <div className="doc-from">
          <strong>{doc.seller.name}</strong>
          {doc.seller.legalName !== doc.seller.name && <div>{doc.seller.legalName}</div>}
          {doc.seller.address && <div>{doc.seller.address}</div>}
          {doc.seller.phone && <div>{doc.seller.phone}</div>}
          {doc.seller.email && <div>{doc.seller.email}</div>}
          {doc.seller.taxId && <div>{t('doc.taxId', { id: doc.seller.taxId })}</div>}
        </div>
      </header>

      <section className="doc-parties">
        <div><h2>{t('doc.billedTo')}</h2><p>{doc.buyer.businessName ?? doc.buyer.name}{doc.buyer.businessName && <><br />{doc.buyer.name}</>}<br />{doc.buyer.email}{doc.buyer.phone && <><br />{doc.buyer.phone}</>}{doc.buyer.taxId && <><br />{t('doc.taxId', { id: doc.buyer.taxId })}</>}</p></div>
        <div><h2>{t('doc.deliveredTo')}</h2><p>{doc.deliveryTo.recipient}<br />{doc.deliveryTo.line1}{doc.deliveryTo.line2 ? `, ${doc.deliveryTo.line2}` : ''}<br />{doc.deliveryTo.city}, {doc.deliveryTo.state}</p></div>
      </section>

      <table className="doc-lines">
        <thead><tr><th>{t('doc.col.item')}</th><th className="num">{t('doc.col.qty')}</th><th className="num">{t('doc.col.price')}</th><th className="num">{t('doc.col.tax')}</th><th className="num">{t('doc.col.total')}</th></tr></thead>
        <tbody>
          {doc.lines.map((l, i) => (
            <tr key={i}><td>{l.title}<div className="small muted">{l.sku}</div></td><td className="num">{trimQty(l.quantity)}</td><td className="num">{trimQty(l.unitPrice)}</td>
              <td className="num">{l.taxRatePct ? `${trimQty(l.taxRatePct)}%` : '—'}</td><td className="num">{m(l.totalMinor)}</td></tr>
          ))}
        </tbody>
        <tfoot>
          <tr><th colSpan={4}>{t('doc.goods')}</th><td className="num">{m(doc.goodsMinor)}</td></tr>
          {doc.discountMinor > 0 && <tr><td colSpan={4} className="small muted">{doc.couponCode ? t('doc.coupon', { code: doc.couponCode }) : t('doc.discount')}: {m(doc.discountMinor)}</td><td /></tr>}
          <tr><th colSpan={4}>{t('doc.delivery')}</th><td className="num">{doc.deliveryFeeMinor === 0 ? t('doc.free') : m(doc.deliveryFeeMinor)}</td></tr>
          <tr className="doc-total"><th colSpan={4}>{t('doc.total')}</th><td className="num">{m(doc.totalMinor)}</td></tr>
        </tfoot>
      </table>

      {doc.taxSummary.length > 0 && (
        <table className="doc-tax">
          <caption>{t('doc.taxSummary')}</caption>
          <thead><tr><th>{t('doc.col.rate')}</th><th className="num">{t('doc.col.taxable')}</th><th className="num">{t('doc.col.tax')}</th></tr></thead>
          <tbody>{doc.taxSummary.map((s) => <tr key={s.taxCode}><td>{s.taxCode} ({trimQty(s.ratePct)}%)</td><td className="num">{m(s.taxableMinor)}</td><td className="num">{m(s.taxMinor)}</td></tr>)}</tbody>
        </table>
      )}

      {(doc.payments.length > 0 || doc.refunds.length > 0) && (
        <section>
          <h2>{t('doc.payments')}</h2>
          <ul className="plain">
            {doc.payments.map((p, i) => <li key={i}>{day(p.at)} · {t(`doc.method.${p.method}`)} · {p.reference} · <strong>{m(p.amountMinor)}</strong></li>)}
            {doc.refunds.map((r, i) => <li key={`r${i}`}>{day(r.at)} · {t('doc.refunds')} · {t(`doc.method.${r.method}`)} · <strong>−{m(r.amountMinor)}</strong></li>)}
          </ul>
        </section>
      )}

      <section className="doc-balance">
        {doc.balanceMinor > 0 ? (
          <>
            <p><strong>{t('doc.balance')}: {m(doc.balanceMinor)}</strong></p>
            {doc.bank && <p>{t('doc.payTo')} {[doc.bank.bankName, doc.bank.accountName, doc.bank.accountNumber].filter(Boolean).join(' · ')}<br />{t('doc.reference', { no: doc.orderNo })}</p>}
          </>
        ) : !cancelled && doc.paidMinor > 0 ? <p><strong>{t('doc.paidInFull')}</strong></p> : null}
      </section>
      {doc.seller.footer && <footer className="doc-footer small muted">{doc.seller.footer}</footer>}
    </article>
  );
}

export default function InvoicePage() {
  return <div className="wrap section"><RequireShopper><InvoiceView /></RequireShopper></div>;
}
