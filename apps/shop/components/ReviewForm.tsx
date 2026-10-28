'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { shopRequest } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { plural, useI18n } from '@/lib/i18n';

export function ReviewForm({ productSlug }: { productSlug: string }) {
  const { signedIn, token, profile } = useAuth();
  const { t } = useI18n();
  const [rating, setRating] = useState(5);
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [error, setError] = useState('');

  if (!signedIn || profile !== 'ready') {
    return <p className="muted">{t('reviews.bought')} <Link href={`/login?next=${encodeURIComponent(`/product/${productSlug}`)}`}>{t('reviews.signInLink')}</Link> {t('reviews.toShare')}</p>;
  }
  if (state === 'sent') return <p className="ok" role="status">{t('reviews.thanks')}</p>;

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setState('sending'); setError('');
    try {
      await shopRequest('/me/reviews', { token: token!, body: { productSlug, rating, title: String(f.get('title') ?? '').trim() || undefined, body: String(f.get('body') ?? '').trim() } });
      setState('sent');
    } catch (err) { setError((err as Error).message); setState('idle'); }
  };
  return (
    <form className="card stack" onSubmit={submit}>
      <h3>{t('reviews.write')}</h3>
      <fieldset style={{ border: 0, padding: 0 }}>
        <legend className="small" style={{ fontWeight: 600 }}>{t('reviews.rating')}</legend>
        <div className="opt">{[1, 2, 3, 4, 5].map((n) => <button key={n} type="button" aria-pressed={rating === n} aria-label={t(plural('reviews.stars', n), { n })} onClick={() => setRating(n)}>{n}★</button>)}</div>
      </fieldset>
      <div className="field"><label htmlFor="rv-title">{t('reviews.headline')}</label><input id="rv-title" name="title" maxLength={100} /></div>
      <div className="field"><label htmlFor="rv-body">{t('reviews.body')}</label><textarea id="rv-body" name="body" required minLength={10} maxLength={2000} /></div>
      {error && <p className="err" role="alert">{error}</p>}
      <button className="btn" disabled={state === 'sending'}>{state === 'sending' ? t('sending') : t('reviews.submit')}</button>
    </form>
  );
}
