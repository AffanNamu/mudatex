import { Notice } from '../../components/ui';
import { removeOutbox } from '../../lib/stockStore';
import type { Stock } from '../../lib/useStock';

/** Everything saved on this phone that the server has not accepted yet. */
export function Waiting({ stock }: { stock: Stock }) {
  const discard = async (id: string) => {
    if (!window.confirm('Throw this away? What was counted or received here will not be recorded.')) return;
    await removeOutbox(id);
    await stock.reloadOutbox();
  };
  return (
    <section className="stock-section">
      {stock.outbox.length === 0 && <p className="muted">Nothing is waiting. Everything you have counted or received has been sent.</p>}
      {stock.outbox.some((o) => o.status === 'waiting') && (
        <div className="stock-actions">
          <button type="button" className="btn btn-primary" disabled={!stock.online || stock.sending} onClick={() => void stock.flush()}>{stock.sending ? 'Sending…' : 'Send now'}</button>
          {!stock.online && <span className="muted small">No connection right now.</span>}
        </div>
      )}
      <ul className="stock-rows">
        {stock.outbox.map((o) => (
          <li key={o.id} className="stock-row stock-row-wide">
            <div className="stock-row-name">
              <strong>{o.label}</strong>
              <span className="muted small">Taken {new Date(o.createdAt).toLocaleString()}</span>
            </div>
            {o.status === 'rejected'
              ? <><div role="alert" className="banner banner-error">Not accepted: {o.reason}</div><button type="button" className="btn" onClick={() => void discard(o.id)}>Discard</button></>
              : <Notice tone="warn">Waiting to be sent</Notice>}
          </li>
        ))}
      </ul>
      {stock.recent.length > 0 && (
        <>
          <h2>Sent this session</h2>
          <ul className="stock-rows">{stock.recent.map((s) => <li key={s.item.id} className="stock-row"><span>{s.item.label}</span><span className="muted small">sent ✓</span></li>)}</ul>
        </>
      )}
    </section>
  );
}
