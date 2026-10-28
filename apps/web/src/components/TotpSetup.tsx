import { useEffect, useState, type FormEvent } from 'react';
import { enrollTotp, verifyTotp, type Tokens, type TotpEnrolment } from '../lib/identity';
import { ErrorBanner, Field } from './ui';

/** Sets up an authenticator app: scan the picture (or type the key), then prove it with the first code. */
export function TotpSetup({ accessToken, onVerified }: { accessToken(): string | null; onVerified(t: Tokens): void | Promise<void> }) {
  const [e, setE] = useState<TotpEnrolment | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    const t = accessToken();
    if (!t) return;
    enrollTotp(t).then((r) => { if (live) setE(r); }).catch((err) => { if (live) setError(err); });
    return () => { live = false; };
  }, [accessToken]);

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    const t = accessToken();
    if (!e || !t) return;
    setBusy(true); setError(null);
    try { await onVerified(await verifyTotp(t, e.factorId, code)); }
    catch (err) { setError(err); setCode(''); }
    finally { setBusy(false); }
  };

  if (!e) return <><ErrorBanner error={error} /><p role="status" className="muted">Preparing…</p></>;
  return (
    <form onSubmit={submit} className="stack">
      <ol>
        <li>Install an authenticator app on your phone (Google Authenticator, Microsoft Authenticator, Authy or similar).</li>
        <li>Scan this picture with the app.<br /><img src={e.qrCode} alt="QR code for your authenticator app" width={180} height={180} /></li>
        <li>Cannot scan? Type this key into the app instead: <code>{e.secret}</code></li>
        <li>Enter the 6-digit code the app shows now.</li>
      </ol>
      <Field label="6-digit code">
        <input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" maxLength={7} required value={code} onChange={(ev) => setCode(ev.target.value)} />
      </Field>
      <button className="btn btn-primary" disabled={busy || code.replace(/\s/g, '').length !== 6}>{busy ? 'Checking…' : 'Turn on two-step sign-in'}</button>
      <ErrorBanner error={error} />
    </form>
  );
}
