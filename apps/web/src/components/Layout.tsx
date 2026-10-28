import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../lib/auth';

const NAV: { to: string; label: string; needs: string }[] = [
  { to: '/pos', label: 'Point of sale', needs: 'pos.sell' },
  { to: '/returns', label: 'Returns', needs: 'pos.refund' },
  { to: '/payments', label: 'Confirm payments', needs: 'pos.payment.verify' },
  { to: '/orders', label: 'Online orders', needs: 'orders.read' },
  { to: '/enquiries', label: 'Enquiries', needs: 'enquiries.manage' },
  { to: '/reviews', label: 'Reviews', needs: 'reviews.moderate' },
  { to: '/trade', label: 'Trade accounts', needs: 'trade.manage' },
  { to: '/quotes', label: 'Quotes', needs: 'quotes.manage' },
  { to: '/standing-orders', label: 'Standing orders', needs: 'trade.manage' },
  { to: '/collections', label: 'Collections', needs: 'trade.manage' },
  { to: '/store', label: 'Online store', needs: 'storefront.manage' },
  { to: '/catalogue', label: 'Catalogue', needs: 'catalog.read' },
  { to: '/stock', label: 'Stock (phone)', needs: 'inventory.read' },
  { to: '/inventory', label: 'Inventory', needs: 'inventory.read' },
  { to: '/till-exceptions', label: 'Offline shortfalls', needs: 'inventory.adjust' },
  { to: '/purchasing', label: 'Purchasing', needs: 'procurement.read' },
  { to: '/manufacturing', label: 'Manufacturing', needs: 'manufacturing.read' },
  { to: '/accounting', label: 'Accounting', needs: 'accounting.read' },
  { to: '/setup', label: 'Setup', needs: 'org.manage' },
  { to: '/access', label: 'People & access', needs: 'iam.manage' },
];

export function Layout() {
  const { session, signOut, can } = useAuth();
  if (!session) return null;
  return (
    <div className="shell">
      <a className="skip" href="#main">Skip to content</a>
      <header className="topbar">
        <strong className="brand">Mudatex</strong>
        <nav aria-label="Main">
          {NAV.filter((n) => can(n.needs)).map((n) => (
            <NavLink key={n.to} to={n.to} className={({ isActive }) => (isActive ? 'active' : undefined)}>{n.label}</NavLink>
          ))}
        </nav>
        <div className="who">
          <span className="muted" title={session.user.email}>{session.user.displayName}</span>
          <NavLink to="/security" className="btn btn-ghost">Security</NavLink>
          <button type="button" className="btn btn-ghost" onClick={signOut}>Sign out</button>
        </div>
      </header>
      <main id="main" className="content"><Outlet /></main>
    </div>
  );
}
