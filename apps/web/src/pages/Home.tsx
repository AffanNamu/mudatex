import { useState } from 'react';
import { Link } from 'react-router-dom';
import { SalesChart } from '../components/SalesChart';
import { ErrorBanner, Loading, PageHeader } from '../components/ui';
import { useAuth } from '../lib/auth';
import { useLoad } from '../lib/hooks';
import { formatMoney } from '../lib/money';

interface Overview {
  days: number;
  sales: { currency: string; minorUnit: number; series: { date: string; pos: number; online: number }[]; totals: { pos: number; online: number; posSales: number; onlineOrders: number }; topProducts: { sku: string; name: string; quantity: number; revenueMinor: number }[] }[];
  lowStock: { sku: string; name: string; location: string; available: number }[];
  attention: Record<string, number>;
}

const ATTENTION: { key: string; label: (n: number) => string; to: string }[] = [
  { key: 'ordersAwaitingPayment', label: (n) => `${n} online order${n === 1 ? '' : 's'} awaiting payment`, to: '/orders' },
  { key: 'ordersToShip', label: (n) => `${n} online order${n === 1 ? '' : 's'} to prepare or ship`, to: '/orders' },
  { key: 'newEnquiries', label: (n) => `${n} new website enquir${n === 1 ? 'y' : 'ies'}`, to: '/enquiries' },
  { key: 'reviewsToApprove', label: (n) => `${n} review${n === 1 ? '' : 's'} to approve`, to: '/reviews' },
  { key: 'tradeApplications', label: (n) => `${n} wholesale application${n === 1 ? '' : 's'}`, to: '/trade' },
  { key: 'offlineShortfalls', label: (n) => `${n} offline stock shortfall${n === 1 ? '' : 's'} to explain`, to: '/till-exceptions' },
];

/** How the business is doing, for the people allowed to see sales. */
function Dashboard() {
  const [days, setDays] = useState(30);
  const o = useLoad<Overview>(`/v1/reports/overview?days=${days}`);
  const d = o.data;
  const waiting = d ? ATTENTION.filter((a) => (d.attention[a.key] ?? 0) > 0) : [];
  return (
    <section aria-label="Dashboard" className="stack">
      <div className="row-between">
        <h2>How we are doing</h2>
        <label className="field inline"><span className="field-label">Period</span>
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}><option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option></select>
        </label>
      </div>
      <ErrorBanner error={o.error} />
      {o.loading && !d && <Loading what="the dashboard" />}
      {waiting.length > 0 && (
        <ul className="cards" aria-label="Needs your attention">
          {waiting.map((a) => <li key={a.key}><Link to={a.to} className="card"><strong>{d!.attention[a.key]}</strong> {a.label(d!.attention[a.key]!).replace(/^\d+ /, '')}</Link></li>)}
        </ul>
      )}
      {d?.sales.map((c) => {
        const fmt = (m: number) => formatMoney(m, c.currency, c.minorUnit);
        const total = c.totals.pos + c.totals.online;
        return (
          <article key={c.currency} className="panel" aria-label={`Sales in ${c.currency}`}>
            <h3>Sales in {c.currency}</h3>
            <dl className="totals">
              <div className="grand"><dt>Total</dt><dd data-testid={`total-${c.currency}`}>{fmt(total)}</dd></div>
              <div><dt>Till ({c.totals.posSales} sales)</dt><dd>{fmt(c.totals.pos)}</dd></div>
              <div><dt>Online ({c.totals.onlineOrders} orders)</dt><dd>{fmt(c.totals.online)}</dd></div>
            </dl>
            <SalesChart series={c.series} currency={c.currency} minorUnit={c.minorUnit} />
            {c.topProducts.length > 0 && (
              <div className="table-wrap"><table>
                <caption>Best sellers</caption>
                <thead><tr><th scope="col">Product</th><th scope="col" className="num">Sold</th><th scope="col" className="num">Revenue</th></tr></thead>
                <tbody>{c.topProducts.map((p) => <tr key={p.sku}><th scope="row">{p.name}<br /><span className="muted">{p.sku}</span></th><td className="num">{p.quantity}</td><td className="num">{fmt(p.revenueMinor)}</td></tr>)}</tbody>
              </table></div>
            )}
          </article>
        );
      })}
      {d && d.sales.length === 0 && <p className="muted">No sales in this period yet.</p>}
      {d && d.lowStock.length > 0 && (
        <article className="panel" aria-label="Running low">
          <h3>Running low</h3>
          <ul className="plain">{d.lowStock.map((l) => <li key={`${l.sku}-${l.location}`}>{l.name} <span className="muted">({l.sku}, {l.location})</span>: <strong>{l.available}</strong> left</li>)}</ul>
        </article>
      )}
    </section>
  );
}


export function Home() {
  const { session, can } = useAuth();
  if (!session) return null;
  const perms = Object.keys(session.permissions).sort();
  const links = [
    { to: '/pos', label: 'Open the till', needs: 'pos.sell' },
    { to: '/returns', label: 'Take a return', needs: 'pos.refund' },
    { to: '/payments', label: 'Confirm payments and refunds', needs: 'pos.payment.verify' },
    { to: '/catalogue', label: 'Browse the catalogue', needs: 'catalog.read' },
    { to: '/inventory', label: 'See stock', needs: 'inventory.read' },
    { to: '/purchasing', label: 'Purchase orders', needs: 'procurement.read' },
    { to: '/manufacturing', label: 'Production', needs: 'manufacturing.read' },
    { to: '/accounting', label: 'Open the books', needs: 'accounting.read' },
    { to: '/access', label: 'People and access', needs: 'iam.manage' },
  ].filter((l) => can(l.needs));
  return (
    <>
      <PageHeader title={`Welcome, ${session.user.displayName}`} />
      {links.length ? (
        <ul className="cards">{links.map((l) => <li key={l.to}><Link to={l.to} className="card">{l.label}</Link></li>)}</ul>
      ) : <p>You do not have access to anything yet. Ask an administrator to grant you a role.</p>}
      {(can('pos.read') || can('orders.read')) && <Dashboard />}
      <details className="muted small">
        <summary>Your permissions ({perms.length})</summary>
        <p>{perms.join(', ') || 'None'}</p>
      </details>
    </>
  );
}
