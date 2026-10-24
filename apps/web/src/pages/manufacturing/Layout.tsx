import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../../lib/auth';
import { PageHeader } from '../../components/ui';

export function ManufacturingLayout() {
  const { can } = useAuth();
  return (
    <>
      <PageHeader title="Manufacturing" />
      <nav aria-label="Manufacturing sections" className="subnav">
        <NavLink to="work-orders">Work orders</NavLink>
        <NavLink to="boms">Bills of materials</NavLink>
        {(can('quality.hold') || can('quality.release')) && <NavLink to="quality">Quality holds</NavLink>}
      </nav>
      <Outlet />
    </>
  );
}

export interface Location { id: string; name: string; type: string }
export const HOLDS_STOCK = new Set(['branch', 'warehouse', 'storage_location']);
