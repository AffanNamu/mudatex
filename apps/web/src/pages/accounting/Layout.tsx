import { useState } from 'react';
import { NavLink, Outlet, useOutletContext } from 'react-router-dom';
import { ErrorBanner, Loading, Notice, PageHeader } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { useLoad } from '../../lib/hooks';

export interface Entity { id: string; name: string; countryCode: string; functionalCurrency: string; minorUnit: number }
export const useEntity = () => useOutletContext<{ entity: Entity }>().entity;

export const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** Accounting is kept per company: pick one, then work in its books. */
export function AccountingLayout() {
  const { can } = useAuth();
  const entities = useLoad<Entity[]>('/v1/legal-entities');
  const [picked, setPicked] = useState('');
  const list = entities.data ?? [];
  const entity = list.find((e) => e.id === picked) ?? list[0];

  return (
    <>
      <PageHeader title="Accounting">
        {list.length > 1 && (
          <label className="field inline"><span className="field-label">Company</span>
            <select value={entity?.id ?? ''} onChange={(e) => setPicked(e.target.value)}>
              {list.map((e) => <option key={e.id} value={e.id}>{e.name} ({e.functionalCurrency})</option>)}
            </select>
          </label>
        )}
      </PageHeader>
      <ErrorBanner error={entities.error} />
      {entities.loading && <Loading what="companies" />}
      {!entities.loading && !entity && <Notice>No company is visible to you.</Notice>}
      {entity && (
        <>
          <nav aria-label="Accounting sections" className="subnav">
            <NavLink to="journals">Journals</NavLink>
            <NavLink to="accounts">Chart of accounts</NavLink>
            <NavLink to="trial-balance">Trial balance</NavLink>
            <NavLink to="periods">Periods</NavLink>
            {can('accounting.read') && <NavLink to="rates">Exchange rates</NavLink>}
          </nav>
          <p className="muted">{entity.name} · amounts in {entity.functionalCurrency}</p>
          <Outlet key={entity.id} context={{ entity }} />
        </>
      )}
    </>
  );
}
