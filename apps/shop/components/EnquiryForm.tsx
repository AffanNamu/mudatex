'use client';

import { useState, type FormEvent } from 'react';
import { shopRequest } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

type Kind = 'contact' | 'wholesale' | 'custom_order' | 'careers';

/** `messageLabel`, `placeholder` and `cta` are message keys, so the form follows the shopper's language. */
export function EnquiryForm({ kind, messageLabel, placeholder, showCompany = false, cta = 'enq.send' }: {
  kind: Kind; messageLabel: string; placeholder?: string; showCompany?: boolean; cta?: string;
}) {
  const { t } = useI18n();
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [error, setError] = useState('');
  const [reference, setReference] = useState('');

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const get = (k: string) => String(f.get(k) ?? '').trim();
    setState('sending'); setError('');
    try {
      const res = await shopRequest<{ reference?: string }>('/enquiries', { body: {
        kind, name: get('name'), email: get('email') || undefined, phone: get('phone') || undefined,
        company: get('company') || undefined, message: get('message'), website: get('website') || undefined,
      } });
      setReference(res.reference ?? '');
      setState('sent');
    } catch (err) {
      setError((err as Error).message);
      setState('idle');
    }
  };

  if (state === 'sent') {
    return (
      <div className="card stack" role="status">
        <h2>{t('enq.thanks')}</h2>
        <p>{t('enq.reply')}{reference && <> {t('enq.reference')} <strong>{reference}</strong>.</>}</p>
      </div>
    );
  }
  return (
    <form className="card stack" onSubmit={submit}>
      <div className="grid2">
        <div className="field"><label htmlFor="eq-name">{t('enq.name')}</label><input id="eq-name" name="name" required minLength={2} maxLength={120} autoComplete="name" /></div>
        {showCompany && <div className="field"><label htmlFor="eq-company">{t('enq.company')}</label><input id="eq-company" name="company" maxLength={150} autoComplete="organization" /></div>}
      </div>
      <div className="grid2">
        <div className="field"><label htmlFor="eq-phone">{t('enq.phone')}</label><input id="eq-phone" name="phone" type="tel" autoComplete="tel" /></div>
        <div className="field"><label htmlFor="eq-email">{t('enq.email')}</label><input id="eq-email" name="email" type="email" autoComplete="email" /></div>
      </div>
      <p className="small muted" style={{ margin: 0 }}>{t('enq.atLeastOne')}</p>
      <div className="field"><label htmlFor="eq-message">{t(messageLabel)}</label><textarea id="eq-message" name="message" required minLength={10} maxLength={3000} placeholder={placeholder ? t(placeholder) : undefined} /></div>
      {/* Hidden from people; bots tend to fill every field. */}
      <div aria-hidden="true" style={{ position: 'absolute', left: '-9999px' }}>
        <label htmlFor="eq-website">{t('enq.website')}</label><input id="eq-website" name="website" tabIndex={-1} autoComplete="off" />
      </div>
      {error && <p className="err" role="alert">{error}</p>}
      <button className="btn" disabled={state === 'sending'}>{state === 'sending' ? t('sending') : t(cta)}</button>
    </form>
  );
}
