import { useState, type FormEvent } from 'react';
import { Navigate } from 'react-router-dom';
import { ErrorBanner, Field, Notice } from '../components/ui';
import { ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { SignInError, requestPasswordReset } from '../lib/identity';
import { TotpSetup } from '../components/TotpSetup';

export function Login() {
  const { session, signIn, loading, mode, pending, verifyCode, adoptVerified, accessToken, signOut } = useAuth();
  const [code, setCode] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [reset, setReset] = useState(false);
  const [resetSent, setResetSent] = useState(false);
  if (session) return <Navigate to="/" replace />;
  if (loading) return <p role="status" className="muted center">Signing in…</p>;

  const explain = (err: unknown) => {
    if (err instanceof SignInError) return err;
    // The identity provider accepted the person but Mudatex has no active user for them.
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) return new Error('Your sign-in worked, but you have not been set up in Mudatex yet (or your access is suspended). Ask an administrator.');
    if (err instanceof ApiError && err.status === 404) return new Error('No active user with that email.');
    return err;
  };

  const submitCode = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try { await verifyCode(code); } catch (err) { setError(explain(err)); setCode(''); } finally { setBusy(false); }
  };

  if (pending?.kind === 'challenge') {
    return (
      <main className="login">
        <h1>Mudatex</h1>
        <form onSubmit={submitCode}>
          <p>Enter the 6-digit code from your authenticator app.</p>
          <Field label="6-digit code">
            <input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" maxLength={7} required value={code} onChange={(e) => setCode(e.target.value)} autoFocus />
          </Field>
          <button className="btn btn-primary" type="submit" disabled={busy || code.replace(/\s/g, '').length !== 6}>{busy ? 'Checking…' : 'Verify'}</button>
          <button type="button" className="link" onClick={signOut}>Use a different account</button>
        </form>
        <ErrorBanner error={error} />
      </main>
    );
  }
  if (pending?.kind === 'enrol') {
    return (
      <main className="login">
        <h1>Mudatex</h1>
        <h2>Set up two-step sign-in</h2>
        <p>Your company requires a second step when you sign in. It takes a minute and protects the company's money and stock.</p>
        <TotpSetup accessToken={accessToken} onVerified={adoptVerified} />
        <button type="button" className="link" onClick={signOut}>Sign out</button>
      </main>
    );
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      if (reset) { await requestPasswordReset(email.trim()); setResetSent(true); }
      else await signIn(email.trim(), password);
    } catch (err) { setError(explain(err)); }
    finally { setBusy(false); }
  };

  return (
    <main className="login">
      <h1>Mudatex</h1>
      <form onSubmit={submit} aria-describedby={mode === 'dev' ? 'dev-note' : undefined}>
        <Field label="Email">
          <input type="email" name="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        </Field>
        {mode === 'password' && !reset && (
          <Field label="Password">
            <input type="password" name="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
        )}
        <button className="btn btn-primary" type="submit" disabled={busy || !email || (mode === 'password' && !reset && !password)}>
          {reset ? 'Email me a reset link' : busy ? 'Signing in…' : 'Sign in'}
        </button>
        {mode === 'password' && (
          <button type="button" className="link" onClick={() => { setReset(!reset); setResetSent(false); setError(null); }}>
            {reset ? 'Back to sign in' : 'Forgot your password?'}
          </button>
        )}
      </form>
      <ErrorBanner error={error} />
      {resetSent && <Notice tone="ok">If that address has an account, a reset link is on its way.</Notice>}
      {mode === 'dev' && <p id="dev-note" className="muted small">Development sign-in. Production sign-in with your company identity provider is not connected here.</p>}
    </main>
  );
}
