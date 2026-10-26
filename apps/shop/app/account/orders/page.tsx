'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { shopRequest } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useCart } from '@/lib/cart';
import { formatMoney, STATUS_LABEL } from '@/lib/format';

interface Row { orderNo: string; status: string; currency: string; totalMinor: number; placedAt: string; lineCount: number }

export default function Orders() {
  const { token } = useAuth();
  const { store } = useCart();
  const [rows, setRows] = useState<Row[] | null>(null);
  useEffect(() => { if (token) shopRequest<Row[]>('/me/orders', { token }).then(setRows).catch(() => setRows([])); }, [token]);
  if (!rows) return <p className="muted" role="status">Loading…</p>;
  if (!rows.length) return <div className="empty"><h2>No orders yet</h2><Link className="btn" href="/shop">Start shopping</Link></div>;
  return (
    <table className="plain">
      <thead><tr><th>Order</th><th>Placed</th><th>Items</th><th>Total</th><th>Status</th></tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.orderNo}>
            <td><Link href={`/orders/${r.orderNo}`}>{r.orderNo}</Link></td>
            <td>{new Date(r.placedAt).toLocaleDateString()}</td>
            <td>{r.lineCount}</td>
            <td>{formatMoney(r.totalMinor, r.currency, store.minorUnit)}</td>
            <td><span className={`status ${r.status}`}>{STATUS_LABEL[r.status] ?? r.status}</span></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
