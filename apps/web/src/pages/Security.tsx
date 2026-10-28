import { useCallback, useEffect, useState } from 'react';
import { TotpSetup } from '../components/TotpSetup';
import { ErrorBanner, Loading, Notice, PageHeader } from '../components/ui';
import { useAuth } from '../lib/auth';
import { listFactors, removeFactor, tokenAal, type Factor } from '../lib/identity';

/** Your own sign-in security: the authenticator app for the second step. */
export function Security() {
  const { mode, accessToken, adoptVerified } = useAuth();
  const [factors, setFactors] = useState<Factor[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState('');

  const reload = useCallback(() => {
    const t = accessToken();
    if (!t) return;
    listFactors(t).then(setFactors).catch(setError);
  }, [accessToken]);
  useEffect(() => { if (mode === 'password') reload(); }, [mode, reload]);

  if (mode !== 'password') return <><PageHeader title="Sign-in security" /><Notice>The development sign-in has no second step. It applies once the company's sign-in service is connected.</Notice></>;
  const verified = factors?.filter((f) => f.status === 'verified') ?? [];
  const remove = async (f: Factor) => {
    const t = accessToken();
    if (!t) return;
    setError(null); setDone('');
    try { await removeFactor(t, f.id); setDone('Removed. You will no longer be asked for a code.'); reload(); } catch (e) { setError(e); }
  };

  return (
    <>
      <PageHeader title="Sign-in security" />
      <ErrorBanner error={error} />
      {done && <Notice tone="ok">{done}</Notice>}
      {!factors ? <Loading what="your sign-in settings" /> : (
        <section className="panel" aria-label="Two-step sign-in">
          <h2>Two-step sign-in</h2>
          {verified.length ? (
            <>
              <p>On. After your password you are asked for a 6-digit code from your authenticator app{tokenAal(accessToken() ?? '') === 'aal2' ? '' : ' (sign in with a code to change this)'}.</p>
              <ul className="plain">{verified.map((f) => <li key={f.id} className="row-between"><span>{f.friendlyName ?? 'Authenticator app'}</span><button className="btn" onClick={() => remove(f)}>Remove</button></li>)}</ul>
            </>
          ) : adding ? (
            <TotpSetup accessToken={accessToken} onVerified={async (t) => { await adoptVerified(t); setAdding(false); setDone('Two-step sign-in is on.'); reload(); }} />
          ) : (
            <>
              <p>Off. Add an authenticator app so that a stolen password alone cannot open the company's records.</p>
              <button className="btn btn-primary" onClick={() => { setAdding(true); setDone(''); }}>Set up an authenticator app</button>
            </>
          )}
        </section>
      )}
    </>
  );
}
