'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, type FormEvent, type ReactNode } from 'react';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';

/** Children render only for a signed-in shopper with a profile; otherwise the right next step is shown. */
export function RequireShopper({ children }: { children: ReactNode }) {
  const { ready, signedIn, profile, createProfile, email } = useAuth();
  const path = usePathname();
  const { t } = useI18n();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (!ready) return <p className="muted" role="status">{t('loading')}</p>;
  if (!signedIn) {
    return (
      <div className="card stack" style={{ maxWidth: 480 }}>
        <h2>{t('require.title')}</h2>
        <p className="muted">{t('require.text')}</p>
        <Link className="btn" href={`/login?next=${encodeURIComponent(path)}`}>{t('require.cta')}</Link>
      </div>
    );
  }
  if (profile === 'loading') return <p className="muted" role="status">{t('require.loadingAccount')}</p>;
  if (profile === 'needed') {
    const submit = async (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const f = new FormData(e.currentTarget);
      setBusy(true); setError('');
      try {
        await createProfile({ fullName: String(f.get('fullName')).trim(), phone: String(f.get('phone') ?? '').trim() || undefined, marketingOptIn: f.get('marketing') === 'on' });
      } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
    };
    return (
      <form className="card stack" style={{ maxWidth: 480 }} onSubmit={submit}>
        <h2>{t('require.who')}</h2>
        <p className="muted">{t('require.signedInAs', { email: email ?? '' })}</p>
        <div className="field"><label htmlFor="fullName">{t('require.fullName')}</label><input id="fullName" name="fullName" required minLength={2} autoComplete="name" /></div>
        <div className="field"><label htmlFor="phone">{t('require.phone')}</label><input id="phone" name="phone" type="tel" required pattern="\+?[0-9 ()\-]{7,20}" autoComplete="tel" placeholder="+234…" /></div>
        <label className="row" style={{ fontWeight: 400 }}><input type="checkbox" name="marketing" style={{ width: 'auto', minHeight: 0 }} /> {t('profile.marketing')}</label>
        {error && <p className="err" role="alert">{error}</p>}
        <button className="btn" disabled={busy}>{busy ? t('addr.saving') : t('login.continue')}</button>
      </form>
    );
  }
  return <>{children}</>;
}
