import { useState, type FormEvent } from 'react';
import { ErrorBanner, Field, Notice } from '../components/ui';
import { setNewPassword } from '../lib/identity';

/** Lands here from a password-reset or invitation email. */
export function SetPassword({ linkToken, onDone }: { linkToken: string; onDone(): void }) {
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const short = password.length > 0 && password.length < 10;
  const mismatch = again.length > 0 && again !== password;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { await setNewPassword(linkToken, password); setDone(true); }
    catch (err) { setError(err); }
    finally { setBusy(false); }
  }

  return (
    <main className="login">
      <h1>Choose a password</h1>
      {done ? (
        <>
          <Notice tone="ok">Your password is saved.</Notice>
          <button type="button" className="btn btn-primary" onClick={onDone}>Go to sign in</button>
        </>
      ) : (
        <form onSubmit={submit}>
          <Field label="New password" hint="At least 10 characters" error={short ? 'Too short' : null}>
            <input type="password" autoComplete="new-password" required value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
          </Field>
          <Field label="Type it again" error={mismatch ? 'The two do not match' : null}>
            <input type="password" autoComplete="new-password" required value={again} onChange={(e) => setAgain(e.target.value)} />
          </Field>
          <ErrorBanner error={error} />
          <button className="btn btn-primary" disabled={busy || password.length < 10 || password !== again}>{busy ? 'Saving…' : 'Save password'}</button>
        </form>
      )}
    </main>
  );
}
