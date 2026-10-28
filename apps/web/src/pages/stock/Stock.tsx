import { useSearchParams } from 'react-router-dom';
import { Notice, PageHeader } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { ageMinutes } from '../../lib/stockSheet';
import { useStock } from '../../lib/useStock';
import { Count } from './Count';
import { Lookup } from './Lookup';
import { Receive } from './Receive';
import { Waiting } from './Waiting';

type Tab = 'count' | 'receive' | 'lookup' | 'waiting';

/** Stock on a phone: count a shelf, receive a delivery, look something up. Works through short or long gaps in signal. */
export function Stock() {
  const { session, can } = useAuth();
  const stock = useStock(session!.user.id);
  const [params, setParams] = useSearchParams();
  const tabs: { id: Tab; label: string; show: boolean }[] = [
    { id: 'count', label: 'Count', show: can('inventory.adjust') },
    { id: 'receive', label: 'Receive', show: can('procurement.receive') || can('inventory.receive') },
    { id: 'lookup', label: 'Look up', show: true },
    { id: 'waiting', label: stock.waiting ? `Waiting (${stock.waiting})` : 'Waiting', show: true },
  ];
  const visible = tabs.filter((t) => t.show);
  const asked = params.get('tab') as Tab | null;
  const tab = visible.find((t) => t.id === asked)?.id ?? visible[0]!.id;
  const rejected = stock.outbox.filter((o) => o.status === 'rejected').length;

  return (
    <div className="stock">
      <PageHeader title="Stock" />
      {!stock.online && <Notice tone="warn">No connection. You can keep counting and receiving; it is sent when you are back online.</Notice>}
      <div className="stock-where">
        <label className="field inline">
          <span className="field-label">Place</span>
          <select value={stock.locationId} onChange={(e) => stock.setLocationId(e.target.value)} disabled={!stock.locations.length}>
            {stock.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </label>
        <div className="small muted stock-sheet">
          {stock.sheet ? <>Stock list from {ageMinutes(stock.sheet.generatedAt) < 1 ? 'just now' : `${ageMinutes(stock.sheet.generatedAt)} min ago`}{stock.sheet.truncated ? ' (first 4000 products only)' : ''}</> : 'No stock list on this phone yet'}
          {' '}<button type="button" className="btn btn-ghost" onClick={() => void stock.refreshSheet()} disabled={!stock.online || !stock.locationId}>Refresh</button>
        </div>
      </div>
      {stock.sheetError && <div role="alert" className="banner banner-error">{stock.sheetError}</div>}
      {!stock.locations.length && <Notice>No stock-holding places are visible to you.</Notice>}

      <div role="tablist" aria-label="Stock tasks" className="stock-tabs">
        {visible.map((t) => (
          <button key={t.id} role="tab" type="button" aria-selected={tab === t.id} className={tab === t.id ? 'active' : undefined} onClick={() => setParams({ tab: t.id })}>
            {t.label}{t.id === 'waiting' && rejected > 0 ? ' !' : ''}
          </button>
        ))}
      </div>

      {stock.locationId && (
        <div role="tabpanel" aria-label={visible.find((t) => t.id === tab)?.label}>
          {tab === 'count' && <Count key={stock.locationId} stock={stock} userId={session!.user.id} />}
          {tab === 'receive' && <Receive key={stock.locationId} stock={stock} />}
          {tab === 'lookup' && <Lookup key={stock.locationId} stock={stock} />}
          {tab === 'waiting' && <Waiting stock={stock} />}
        </div>
      )}
    </div>
  );
}
