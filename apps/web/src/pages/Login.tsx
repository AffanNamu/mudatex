import { useState, type FormEvent } from 'react';
import { Navigate } from 'react-router-dom';
import { ErrorBanner, Field } from '../components/ui';
import { ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';

export function Login() {
  const { session, signIn, loading } = useAuth();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  if (session) return <Navigate to="/" replace />;
  if (loading) return <p role="status" className="muted center">Signing in…</p>;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try { await signIn(email.trim()); }
    catch (err) { setError(err instanceof ApiError && err.status === 404 ? new Error('No active user with that email.') : err); }
    finally { setBusy(false); }
  };

  return (
    <main className="login">
      <h1>Mudatex</h1>
      <form onSubmit={submit} aria-describedby="dev-note">
        <Field label="Email">
          <input type="email" name="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        </Field>
        <button className="btn btn-primary" type="submit" disabled={busy || !email}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
      <ErrorBanner error={error} />
      <p id="dev-note" className="muted small">Development sign-in. Production sign-in with your company identity provider is not connected yet.</p>
    </main>
  );
}
