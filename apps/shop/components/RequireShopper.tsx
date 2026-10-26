'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, type FormEvent, type ReactNode } from 'react';
import { useAuth } from '@/lib/auth';

/** Children render only for a signed-in shopper with a profile; otherwise the right next step is shown. */
export function RequireShopper({ children }: { children: ReactNode }) {
  const { ready, signedIn, profile, createProfile, email } = useAuth();
  const path = usePathname();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (!ready) return <p className="muted" role="status">Loading…</p>;
  if (!signedIn) {
    return (
      <div className="card stack" style={{ maxWidth: 480 }}>
        <h2>Sign in to continue</h2>
        <p className="muted">Your basket is saved. Sign in or create an account to checkout and track your orders.</p>
        <Link className="btn" href={`/login?next=${encodeURIComponent(path)}`}>Sign in or create account</Link>
      </div>
    );
  }
  if (profile === 'loading') return <p className="muted" role="status">Loading your account…</p>;
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
        <h2>Tell us who you are</h2>
        <p className="muted">Signed in as {email}. We need your name and phone number so the rider can reach you.</p>
        <div className="field"><label htmlFor="fullName">Full name</label><input id="fullName" name="fullName" required minLength={2} autoComplete="name" /></div>
        <div className="field"><label htmlFor="phone">Phone number</label><input id="phone" name="phone" type="tel" required pattern="\+?[0-9 ()\-]{7,20}" autoComplete="tel" placeholder="+234…" /></div>
        <label className="row" style={{ fontWeight: 400 }}><input type="checkbox" name="marketing" style={{ width: 'auto', minHeight: 0 }} /> Email me about new arrivals and offers</label>
        {error && <p className="err" role="alert">{error}</p>}
        <button className="btn" disabled={busy}>{busy ? 'Saving…' : 'Continue'}</button>
      </form>
    );
  }
  return <>{children}</>;
}
