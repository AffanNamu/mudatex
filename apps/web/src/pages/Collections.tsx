import { Fragment, useState } from 'react';
import { ErrorBanner, Loading, Notice, PageHeader } from '../components/ui';
import { api } from '../lib/api';
import { useLoad } from '../lib/hooks';
import { formatMoney } from '../lib/money';

interface Invoice { orderId: string; orderNo: string; dueOn: string; outstandingMinor: number; totalMinor: number; daysOverdue: number; lastNotice: { stage: string; at: string } | null }
interface Account {
  id: string; businessName: string; contactName: string; email: string; status: string; heldAutomatically: boolean; holdAfterDays: number;
  currency: string; minorUnit: number; outstandingMinor: number; overdueMinor: number; oldestOverdueDays: number; invoices: Invoice[];
}
interface Total { currency: string; minorUnit: number; outstandingMinor: number; overdueMinor: number; buckets: { current: number; d1_30: number; d31_60: number; d61plus: number } }
interface View { asOf: string; accounts: Account[]; totals: Total[] }

const STAGE: Record<string, string> = { due_soon: 'Reminded before due', overdue_1: 'First reminder', overdue_7: 'Second reminder', overdue_14: 'Third reminder', hold: 'Told of the hold', manual: 'Reminded by staff' };
const when = (d: number) => (d > 0 ? `${d} day${d === 1 ? '' : 's'} late` : d === 0 ? 'due today' : `due in ${-d} day${d === -1 ? '' : 's'}`);

/** Who owes what on trade accounts, how late it is, and a way to nudge them. Reminders and holds also happen by themselves. */
export function Collections() {
  const view = useLoad<View>('/v1/collections');
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [ok, setOk] = useState('');

  const remind = async (a: Account) => {
    setBusy(a.id); setError(null); setOk('');
    try {
      const r = await api<{ sentTo: string; invoices: number }>(`/v1/trade-accounts/${a.id}/reminder`, { method: 'POST' });
      setOk(`Reminder sent to ${r.sentTo} about ${r.invoices} order${r.invoices === 1 ? '' : 's'}.`);
      view.reload();
    } catch (e) { setError(e); } finally { setBusy(''); }
  };

  const data = view.data;
  return (
    <>
      <PageHeader title="Collections" />
      <p className="muted">Unpaid orders on trade accounts. Friendly reminders go out by themselves before and after the due date, and a business that stays very late is put on hold until it pays. Record payments on the order in Online orders.</p>
      <ErrorBanner error={view.error ?? error} />
      {ok && <Notice tone="ok">{ok}</Notice>}
      {view.loading && !data && <Loading what="balances" />}
      {data && data.accounts.length === 0 && <Notice>Nothing is owed on any trade account.</Notice>}

      {data?.totals.map((t) => {
        const m = (n: number) => formatMoney(n, t.currency, t.minorUnit);
        const parts = [['Not yet due', t.buckets.current], ['1–30 days late', t.buckets.d1_30], ['31–60 days late', t.buckets.d31_60], ['Over 60 days late', t.buckets.d61plus]] as const;
        return (
          <section key={t.currency} className="panel" aria-label={`Totals in ${t.currency}`}>
            <h2>{t.currency}: {m(t.outstandingMinor)} owed, {m(t.overdueMinor)} overdue</h2>
            <ul className="cards">{parts.map(([label, v]) => <li key={label} className="card"><span className="muted small">{label}</span><br /><strong>{m(v)}</strong></li>)}</ul>
          </section>
        );
      })}

      {data && data.accounts.length > 0 && (
        <div className="table-wrap">
          <table>
            <caption className="sr-only">Balances owed by trade accounts</caption>
            <thead><tr><th scope="col">Business</th><th scope="col">Status</th><th scope="col" className="num">Owed</th><th scope="col" className="num">Overdue</th><th scope="col" className="num">Oldest</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {data.accounts.map((a) => {
                const m = (n: number) => formatMoney(n, a.currency, a.minorUnit);
                const isOpen = open === a.id;
                return (
                  <Fragment key={a.id}>
                    <tr>
                      <th scope="row">{a.businessName}<div className="muted small">{a.contactName} · {a.email}</div></th>
                      <td>{a.status === 'suspended' ? <span className="chip">{a.heldAutomatically ? 'On hold (automatic)' : 'On hold'}</span> : <span className="muted">In good standing</span>}</td>
                      <td className="num">{m(a.outstandingMinor)}</td>
                      <td className="num">{a.overdueMinor ? <strong className="bad">{m(a.overdueMinor)}</strong> : '—'}</td>
                      <td className="num">{a.oldestOverdueDays ? `${a.oldestOverdueDays} days` : '—'}</td>
                      <td>
                        <button type="button" className="btn btn-ghost" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : a.id)}>{isOpen ? 'Hide' : 'Orders'}</button>{' '}
                        <button type="button" className="btn" disabled={busy === a.id} onClick={() => void remind(a)} aria-label={`Send a reminder to ${a.businessName}`}>{busy === a.id ? 'Sending…' : 'Remind'}</button>
                      </td>
                    </tr>
                    {isOpen && (
                      <tr><td colSpan={6}>
                        <table className="plain">
                          <thead><tr><th scope="col">Order</th><th scope="col">Due</th><th scope="col">Age</th><th scope="col" className="num">Owed</th><th scope="col">Last notice</th></tr></thead>
                          <tbody>{a.invoices.map((i) => (
                            <tr key={i.orderId}><th scope="row">{i.orderNo}</th><td>{i.dueOn}</td><td className={i.daysOverdue > 0 ? 'bad' : undefined}>{when(i.daysOverdue)}</td>
                              <td className="num">{m(i.outstandingMinor)}{i.outstandingMinor < i.totalMinor ? <span className="muted small"> of {m(i.totalMinor)}</span> : null}</td>
                              <td>{i.lastNotice ? `${STAGE[i.lastNotice.stage] ?? i.lastNotice.stage}, ${new Date(i.lastNotice.at).toLocaleDateString()}` : '—'}</td></tr>
                          ))}</tbody>
                        </table>
                        {a.holdAfterDays > 0 ? <p className="muted small">Held automatically when an order is {a.holdAfterDays} days late.</p> : <p className="muted small">Automatic hold is off for this business.</p>}
                      </td></tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
