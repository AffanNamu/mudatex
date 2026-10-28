'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';

function LoginForm() {
  const { signIn, signUp, recover, signedIn, configured } = useAuth();
  const router = useRouter();
  const { t } = useI18n();
  const params = useSearchParams();
  const next = params.get('next');
  const target = next && next.startsWith('/') && !next.startsWith('//') ? next : '/account';
  const [mode, setMode] = useState<'in' | 'up' | 'forgot'>('in');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);

  if (signedIn) {
    return <div className="card stack" style={{ maxWidth: 440 }}><h1>{t('login.signedIn')}</h1><Link className="btn" href={target}>{t('login.continue')}</Link></div>;
  }

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const email = String(f.get('email')).trim();
    const password = String(f.get('password') ?? '');
    setBusy(true); setError(''); setInfo('');
    try {
      if (mode === 'forgot') { await recover(email); setInfo(t('login.resetSent')); }
      else if (mode === 'in') { await signIn(email, password); router.push(target); }
      else {
        if (password.length < 8) throw new Error(t('login.pw8'));
        if ((await signUp(email, password)) === 'signed-in') router.push(target);
        else setInfo(t('login.confirmSent'));
      }
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };

  return (
    <form className="card stack" style={{ maxWidth: 440 }} onSubmit={submit} noValidate={false}>
      <h1>{mode === 'in' ? t('login.signInTitle') : mode === 'up' ? t('login.createTitle') : t('login.resetTitle')}</h1>
      {!configured && <p className="notice" role="alert">{t('login.notSetUp')}</p>}
      <div className="field"><label htmlFor="email">{t('login.email')}</label><input id="email" name="email" type="email" required autoComplete="email" /></div>
      {mode !== 'forgot' && (
        <div className="field"><label htmlFor="password">{t('login.password')}</label><input id="password" name="password" type="password" required minLength={mode === 'up' ? 8 : 1} autoComplete={mode === 'in' ? 'current-password' : 'new-password'} /></div>
      )}
      {error && <p className="err" role="alert">{error}</p>}
      {info && <p className="ok" role="status">{info}</p>}
      <button className="btn" disabled={busy || !configured}>{busy ? t('login.wait') : mode === 'in' ? t('login.signInTitle') : mode === 'up' ? t('login.createBtn') : t('login.resetBtn')}</button>
      <div className="small row spread">
        {mode === 'in' ? <><button type="button" className="link" onClick={() => setMode('up')}>{t('login.newHere')}</button><button type="button" className="link" onClick={() => setMode('forgot')}>{t('login.forgot')}</button></>
          : <button type="button" className="link" onClick={() => setMode('in')}>{t('login.back')}</button>}
      </div>
    </form>
  );
}

export default function LoginPage() {
  return <div className="wrap section"><Suspense><LoginForm /></Suspense></div>;
}
