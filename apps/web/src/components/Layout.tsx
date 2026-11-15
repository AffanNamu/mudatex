import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/auth';

interface Item { to: string; label: string; needs: string }
/** The menu, grouped by the kind of work. A person sees only the links they have permission for, and only the groups that still have one. */
export const NAV_GROUPS: { title: string; items: Item[] }[] = [
  { title: 'Sell', items: [
    { to: '/pos', label: 'Point of sale', needs: 'pos.sell' },
    { to: '/returns', label: 'Returns', needs: 'pos.refund' },
    { to: '/payments', label: 'Confirm payments', needs: 'pos.payment.verify' },
  ] },
  { title: 'Online', items: [
    { to: '/orders', label: 'Online orders', needs: 'orders.read' },
    { to: '/customers', label: 'Customers', needs: 'customers.manage' },
    { to: '/enquiries', label: 'Enquiries', needs: 'enquiries.manage' },
    { to: '/reviews', label: 'Reviews', needs: 'reviews.moderate' },
    { to: '/delivery', label: 'Delivery companies', needs: 'carriers.manage' },
    { to: '/store', label: 'Online store', needs: 'storefront.manage' },
  ] },
  { title: 'Wholesale', items: [
    { to: '/trade', label: 'Trade accounts', needs: 'trade.manage' },
    { to: '/quotes', label: 'Quotes', needs: 'quotes.manage' },
    { to: '/standing-orders', label: 'Standing orders', needs: 'trade.manage' },
    { to: '/collections', label: 'Collections', needs: 'trade.manage' },
  ] },
  { title: 'Stock', items: [
    { to: '/catalogue', label: 'Catalogue', needs: 'catalog.read' },
    { to: '/stock', label: 'Stock (phone)', needs: 'inventory.read' },
    { to: '/inventory', label: 'Inventory', needs: 'inventory.read' },
    { to: '/till-exceptions', label: 'Offline shortfalls', needs: 'inventory.adjust' },
  ] },
  { title: 'Buy and make', items: [
    { to: '/purchasing', label: 'Purchasing', needs: 'procurement.read' },
    { to: '/manufacturing', label: 'Manufacturing', needs: 'manufacturing.read' },
  ] },
  { title: 'Money', items: [{ to: '/accounting', label: 'Accounting', needs: 'accounting.read' }] },
  { title: 'Company', items: [
    { to: '/setup', label: 'Setup', needs: 'org.manage' },
    { to: '/access', label: 'People & access', needs: 'iam.manage' },
  ] },
];

export function Layout() {
  const { session, signOut, can } = useAuth();
  const [open, setOpen] = useState(false);
  const location = useLocation();
  // On a phone the menu folds away after a choice.
  useEffect(() => { setOpen(false); }, [location.pathname]);
  if (!session) return null;
  const groups = NAV_GROUPS.map((g) => ({ ...g, items: g.items.filter((n) => can(n.needs)) })).filter((g) => g.items.length > 0);
  return (
    <div className="shell">
      <a className="skip" href="#main">Skip to content</a>
      <header className="topbar">
        <strong className="brand">Mudatex</strong>
        <div className="who">
          <span className="muted" title={session.user.email}>{session.user.displayName}</span>
          <NavLink to="/security" className="btn btn-ghost">Security</NavLink>
          <button type="button" className="btn btn-ghost" onClick={signOut}>Sign out</button>
        </div>
      </header>
      <div className="frame">
        <nav aria-label="Main" className={open ? 'sidenav open' : 'sidenav'}>
          <button type="button" className="btn menu-toggle" aria-expanded={open} aria-controls="nav-groups" onClick={() => setOpen(!open)}>{open ? 'Close menu' : 'Menu'}</button>
          <div id="nav-groups" className="nav-groups">
            <NavLink to="/" end className={({ isActive }) => (isActive ? 'active home-link' : 'home-link')}>Home</NavLink>
            {groups.map((g) => (
              <div key={g.title} role="group" aria-label={g.title}>
                <h2 className="nav-title">{g.title}</h2>
                <ul className="plain">
                  {g.items.map((n) => <li key={n.to}><NavLink to={n.to} className={({ isActive }) => (isActive ? 'active' : undefined)}>{n.label}</NavLink></li>)}
                </ul>
              </div>
            ))}
          </div>
        </nav>
        <main id="main" className="content"><Outlet /></main>
      </div>
    </div>
  );
}
