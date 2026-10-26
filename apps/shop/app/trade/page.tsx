'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { RequireShopper } from '@/components/RequireShopper';
import { ApiError, shopRequest } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useCart } from '@/lib/cart';
import { formatMoney } from '@/lib/format';
import type { TradeAccount } from '@/lib/types';

function Trade() {
  const { token } = useAuth();
  const { store } = useCart();
  const money = (m: number) => formatMoney(m, store.currency, store.minorUnit);
  const [acct, setAcct] = useState<TradeAccount | null | undefined>(undefined);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) return;
    shopRequest<TradeAccount>('/me/trade', { token }).then(setAcct).catch((e) => setAcct(e instanceof ApiError && e.status === 404 ? null : null));
  }, [token]);

  const apply = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true); setError('');
    try {
      setAcct(await shopRequest<TradeAccount>('/me/trade', { token: token!, body: { businessName: String(f.get('businessName')).trim(), ...(String(f.get('taxId')).trim() ? { taxId: String(f.get('taxId')).trim() } : {}) } }));
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };

  if (acct === undefined) return <p className="muted" role="status">Loading…</p>;
  const form = (
    <form className="card stack" style={{ maxWidth: 520 }} onSubmit={apply}>
      <h2>Apply for a trade account</h2>
      <p className="muted">Wholesale prices, credit terms and a statement of your account, for shops and traders. We review every application.</p>
      <div className="field"><label htmlFor="bn">Business name</label><input id="bn" name="businessName" required minLength={2} maxLength={150} autoComplete="organization" /></div>
      <div className="field"><label htmlFor="tin">Tax or registration number (optional)</label><input id="tin" name="taxId" maxLength={50} /></div>
      {error && <p className="err" role="alert">{error}</p>}
      <button className="btn" disabled={busy}>{busy ? 'Sending…' : 'Send application'}</button>
    </form>
  );
  if (!acct) return form;
  return (
    <div className="stack">
      <div className="notice" role="status">
        <strong>{acct.businessName}</strong> — {acct.status === 'pending' ? 'application received. We will contact you once it has been reviewed.' : acct.status === 'approved' ? 'approved.' : acct.status === 'suspended' ? 'your account is on hold. Please contact us.' : 'application not approved.'}
        {acct.note && <> <span className="muted">Note from our team: {acct.note}</span></>}
      </div>
      {acct.status === 'approved' && (
        <>
          <dl className="card summary" style={{ maxWidth: 520 }}>
            <dl>
              <dt>Credit limit</dt><dd>{money(acct.creditLimitMinor)}</dd>
              <dt>Owing now</dt><dd>{money(acct.creditUsedMinor ?? 0)}</dd>
              <dt><strong>Available</strong></dt><dd><strong>{money(acct.creditAvailableMinor ?? 0)}</strong></dd>
              <dt>Payment terms</dt><dd>{acct.paymentTermsDays} days</dd>
            </dl>
          </dl>
          <p>Trade prices are applied automatically while you are signed in. Choose <strong>On account</strong> at checkout.</p>
          <h2>Statement</h2>
          {acct.statement?.length ? (
            <table className="plain">
              <thead><tr><th>Date</th><th>Entry</th><th style={{ textAlign: 'right' }}>Amount</th><th style={{ textAlign: 'right' }}>Balance</th></tr></thead>
              <tbody>{acct.statement.map((l, i) => (
                <tr key={i}><td>{new Date(l.at).toLocaleDateString()}</td><td>{l.kind === 'order' ? `Order ${l.reference}` : `Payment ${l.reference}`}</td>
                  <td style={{ textAlign: 'right' }}>{l.kind === 'order' ? money(l.amountMinor) : `−${money(l.amountMinor)}`}</td><td style={{ textAlign: 'right' }}>{money(l.balanceMinor)}</td></tr>
              ))}</tbody>
            </table>
          ) : <p className="muted">No orders on account yet.</p>}
        </>
      )}
      {acct.status === 'rejected' && form}
    </div>
  );
}

export default function TradePage() {
  return <div className="wrap section"><h1>Trade account</h1><RequireShopper><Trade /></RequireShopper></div>;
}
