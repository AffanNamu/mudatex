import { useState } from 'react';
import { ErrorBanner, Field, Loading, Notice } from '../../components/ui';
import { useLoad } from '../../lib/hooks';
import { formatMoney } from '../../lib/money';
import { today, useEntity } from './Layout';

interface Tb {
  currency: string; asOf: string;
  accounts: { accountId: string; code: string; name: string; type: string; debitMinor: number; creditMinor: number; balanceMinor: number }[];
  totals: { debitMinor: number; creditMinor: number; balanced: boolean };
  accountingEquation: { holds: boolean };
}
interface Ledger {
  code: string; name: string; openingBalanceMinor: number; closingBalanceMinor: number;
  entries: { journalNumber: string; postingDate: string; entryDescription: string; description: string | null; debitMinor: number; creditMinor: number; balanceMinor: number }[];
}

export function TrialBalance() {
  const entity = useEntity();
  const [asOf, setAsOf] = useState(today());
  const [from, setFrom] = useState('');
  const [account, setAccount] = useState<string | null>(null);
  const tb = useLoad<Tb>(asOf ? `/v1/accounting/trial-balance?legalEntityId=${entity.id}&asOf=${asOf}${from ? `&from=${from}` : ''}` : null);
  const fmt = (m: number) => formatMoney(m, entity.functionalCurrency, entity.minorUnit);

  if (account) return <LedgerView id={account} from={from} to={asOf} onBack={() => setAccount(null)} />;
  return (
    <>
      <div className="toolbar">
        <Field label="From (optional)"><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="As of"><input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></Field>
      </div>
      <ErrorBanner error={tb.error} />
      {tb.loading && !tb.data ? <Loading what="trial balance" /> : tb.data && (
        <>
          {tb.data.totals.balanced && tb.data.accountingEquation.holds
            ? <Notice tone="ok">Debits equal credits, and assets plus expenses equal liabilities, equity and revenue.</Notice>
            : <Notice tone="warn">The books do not balance. Do not rely on these figures; tell the system owner.</Notice>}
          <div className="table-wrap">
            <table>
              <caption className="sr-only">Trial balance as of {tb.data.asOf}</caption>
              <thead><tr><th scope="col">Account</th><th scope="col">Type</th><th scope="col" className="num">Debit</th><th scope="col" className="num">Credit</th><th scope="col" className="num">Balance</th></tr></thead>
              <tbody>
                {tb.data.accounts.map((a) => (
                  <tr key={a.accountId}>
                    <th scope="row"><button type="button" className="link" onClick={() => setAccount(a.accountId)}>{a.code} {a.name}</button></th>
                    <td>{a.type}</td><td className="num">{fmt(a.debitMinor)}</td><td className="num">{fmt(a.creditMinor)}</td><td className="num">{fmt(a.balanceMinor)}</td>
                  </tr>
                ))}
                {!tb.data.accounts.length && <tr><td colSpan={5} className="muted">Nothing has been posted up to this date.</td></tr>}
              </tbody>
              <tfoot><tr><th scope="row" colSpan={2}>Totals</th><td className="num"><strong>{fmt(tb.data.totals.debitMinor)}</strong></td><td className="num"><strong>{fmt(tb.data.totals.creditMinor)}</strong></td><td /></tr></tfoot>
            </table>
          </div>
        </>
      )}
    </>
  );
}

function LedgerView({ id, from, to, onBack }: { id: string; from: string; to: string; onBack(): void }) {
  const entity = useEntity();
  const ledger = useLoad<Ledger>(`/v1/accounting/accounts/${id}/ledger?to=${to}${from ? `&from=${from}` : ''}`);
  const fmt = (m: number) => formatMoney(m, entity.functionalCurrency, entity.minorUnit);
  const l = ledger.data;
  return (
    <>
      <button type="button" className="btn btn-ghost" onClick={onBack}>← Trial balance</button>
      <ErrorBanner error={ledger.error} />
      {!l ? ledger.loading && <Loading what="account" /> : (
        <section className="card" aria-label={`Ledger ${l.code}`}>
          <h2>{l.code} {l.name}</h2>
          <div className="table-wrap">
            <table>
              <thead><tr><th scope="col">Date</th><th scope="col">Journal</th><th scope="col">Description</th><th scope="col" className="num">Debit</th><th scope="col" className="num">Credit</th><th scope="col" className="num">Balance</th></tr></thead>
              <tbody>
                <tr><th scope="row" colSpan={5}>Opening balance</th><td className="num">{fmt(l.openingBalanceMinor)}</td></tr>
                {l.entries.map((e, i) => (
                  <tr key={i}><td>{e.postingDate}</td><td>{e.journalNumber}</td><td>{e.description ?? e.entryDescription}</td>
                    <td className="num">{e.debitMinor ? fmt(e.debitMinor) : ''}</td><td className="num">{e.creditMinor ? fmt(e.creditMinor) : ''}</td><td className="num">{fmt(e.balanceMinor)}</td></tr>
                ))}
              </tbody>
              <tfoot><tr><th scope="row" colSpan={5}>Closing balance</th><td className="num"><strong>{fmt(l.closingBalanceMinor)}</strong></td></tr></tfoot>
            </table>
          </div>
        </section>
      )}
    </>
  );
}
