'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';
import { useAuth } from '@/lib/auth';

function LoginForm() {
  const { signIn, signUp, recover, signedIn, configured } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get('next');
  const target = next && next.startsWith('/') && !next.startsWith('//') ? next : '/account';
  const [mode, setMode] = useState<'in' | 'up' | 'forgot'>('in');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);

  if (signedIn) {
    return <div className="card stack" style={{ maxWidth: 440 }}><h1>You&apos;re signed in</h1><Link className="btn" href={target}>Continue</Link></div>;
  }

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const email = String(f.get('email')).trim();
    const password = String(f.get('password') ?? '');
    setBusy(true); setError(''); setInfo('');
    try {
      if (mode === 'forgot') { await recover(email); setInfo('If that email has an account, a reset link is on its way.'); }
      else if (mode === 'in') { await signIn(email, password); router.push(target); }
      else {
        if (password.length < 8) throw new Error('Choose a password of at least 8 characters.');
        if ((await signUp(email, password)) === 'signed-in') router.push(target);
        else setInfo('Almost there — we sent a confirmation link to your email. Open it, then sign in.');
      }
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };

  return (
    <form className="card stack" style={{ maxWidth: 440 }} onSubmit={submit} noValidate={false}>
      <h1>{mode === 'in' ? 'Sign in' : mode === 'up' ? 'Create your account' : 'Reset your password'}</h1>
      {!configured && <p className="notice" role="alert">Sign-in is not set up on this site yet.</p>}
      <div className="field"><label htmlFor="email">Email</label><input id="email" name="email" type="email" required autoComplete="email" /></div>
      {mode !== 'forgot' && (
        <div className="field"><label htmlFor="password">Password</label><input id="password" name="password" type="password" required minLength={mode === 'up' ? 8 : 1} autoComplete={mode === 'in' ? 'current-password' : 'new-password'} /></div>
      )}
      {error && <p className="err" role="alert">{error}</p>}
      {info && <p className="ok" role="status">{info}</p>}
      <button className="btn" disabled={busy || !configured}>{busy ? 'Please wait…' : mode === 'in' ? 'Sign in' : mode === 'up' ? 'Create account' : 'Send reset link'}</button>
      <div className="small row spread">
        {mode === 'in' ? <><button type="button" className="link" onClick={() => setMode('up')}>New here? Create an account</button><button type="button" className="link" onClick={() => setMode('forgot')}>Forgot password?</button></>
          : <button type="button" className="link" onClick={() => setMode('in')}>Back to sign in</button>}
      </div>
    </form>
  );
}

export default function LoginPage() {
  return <div className="wrap section"><Suspense><LoginForm /></Suspense></div>;
}
