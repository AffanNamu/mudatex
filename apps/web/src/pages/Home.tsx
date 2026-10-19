import { Link } from 'react-router-dom';
import { PageHeader } from '../components/ui';
import { useAuth } from '../lib/auth';

export function Home() {
  const { session, can } = useAuth();
  if (!session) return null;
  const perms = Object.keys(session.permissions).sort();
  const links = [
    { to: '/pos', label: 'Open the till', needs: 'pos.sell' },
    { to: '/catalogue', label: 'Browse the catalogue', needs: 'catalog.read' },
    { to: '/inventory', label: 'See stock', needs: 'inventory.read' },
    { to: '/access', label: 'People and access', needs: 'iam.manage' },
  ].filter((l) => can(l.needs));
  return (
    <>
      <PageHeader title={`Welcome, ${session.user.displayName}`} />
      {links.length ? (
        <ul className="cards">{links.map((l) => <li key={l.to}><Link to={l.to} className="card">{l.label}</Link></li>)}</ul>
      ) : <p>You do not have access to anything yet. Ask an administrator to grant you a role.</p>}
      <details className="muted small">
        <summary>Your permissions ({perms.length})</summary>
        <p>{perms.join(', ') || 'None'}</p>
      </details>
    </>
  );
}
