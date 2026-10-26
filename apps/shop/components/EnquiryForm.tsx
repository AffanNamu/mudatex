'use client';

import { useState, type FormEvent } from 'react';
import { shopRequest } from '@/lib/api';

type Kind = 'contact' | 'wholesale' | 'custom_order' | 'careers';

export function EnquiryForm({ kind, messageLabel, placeholder, showCompany = false, cta = 'Send message' }: {
  kind: Kind; messageLabel: string; placeholder?: string; showCompany?: boolean; cta?: string;
}) {
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
        <h2>Thank you — we have your message</h2>
        <p>We will reply by phone or email, usually within one working day.{reference && <> Your reference is <strong>{reference}</strong>.</>}</p>
      </div>
    );
  }
  return (
    <form className="card stack" onSubmit={submit}>
      <div className="grid2">
        <div className="field"><label htmlFor="eq-name">Your name</label><input id="eq-name" name="name" required minLength={2} maxLength={120} autoComplete="name" /></div>
        {showCompany && <div className="field"><label htmlFor="eq-company">Business name (optional)</label><input id="eq-company" name="company" maxLength={150} autoComplete="organization" /></div>}
      </div>
      <div className="grid2">
        <div className="field"><label htmlFor="eq-phone">Phone / WhatsApp</label><input id="eq-phone" name="phone" type="tel" autoComplete="tel" /></div>
        <div className="field"><label htmlFor="eq-email">Email</label><input id="eq-email" name="email" type="email" autoComplete="email" /></div>
      </div>
      <p className="small muted" style={{ margin: 0 }}>Give at least one, so we can reply.</p>
      <div className="field"><label htmlFor="eq-message">{messageLabel}</label><textarea id="eq-message" name="message" required minLength={10} maxLength={3000} placeholder={placeholder} /></div>
      {/* Hidden from people; bots tend to fill every field. */}
      <div aria-hidden="true" style={{ position: 'absolute', left: '-9999px' }}>
        <label htmlFor="eq-website">Website</label><input id="eq-website" name="website" tabIndex={-1} autoComplete="off" />
      </div>
      {error && <p className="err" role="alert">{error}</p>}
      <button className="btn" disabled={state === 'sending'}>{state === 'sending' ? 'Sending…' : cta}</button>
    </form>
  );
}
