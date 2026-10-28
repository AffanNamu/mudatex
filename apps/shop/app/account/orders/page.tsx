'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { shopRequest } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useCart } from '@/lib/cart';
import { formatMoney } from '@/lib/format';
import { useI18n } from '@/lib/i18n';

interface Row { orderNo: string; status: string; currency: string; totalMinor: number; placedAt: string; lineCount: number }

export default function Orders() {
  const { token } = useAuth();
  const { store } = useCart();
  const { t } = useI18n();
  const [rows, setRows] = useState<Row[] | null>(null);
  useEffect(() => { if (token) shopRequest<Row[]>('/me/orders', { token }).then(setRows).catch(() => setRows([])); }, [token]);
  if (!rows) return <p className="muted" role="status">{t('loading')}</p>;
  if (!rows.length) return <div className="empty"><h2>{t('orders.none')}</h2><Link className="btn" href="/shop">{t('cart.startShopping')}</Link></div>;
  return (
    <table className="plain">
      <thead><tr><th>{t('orders.col.order')}</th><th>{t('orders.col.placed')}</th><th>{t('orders.col.items')}</th><th>{t('orders.col.total')}</th><th>{t('orders.col.status')}</th></tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.orderNo}>
            <td><Link href={`/orders/${r.orderNo}`}>{r.orderNo}</Link></td>
            <td>{new Date(r.placedAt).toLocaleDateString()}</td>
            <td>{r.lineCount}</td>
            <td>{formatMoney(r.totalMinor, r.currency, store.minorUnit)}</td>
            <td><span className={`status ${r.status}`}>{t(`status.${r.status}`)}</span></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
