'use client';

import { useState, type FormEvent } from 'react';
import { PushToggle } from '@/components/PushToggle';
import { useAuth } from '@/lib/auth';

export default function Profile() {
  const { customer, email, updateProfile } = useAuth();
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  if (!customer) return null;
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setMsg(''); setError('');
    try {
      await updateProfile({ fullName: String(f.get('fullName')).trim(), phone: String(f.get('phone') ?? '').trim() || null, marketingOptIn: f.get('marketing') === 'on' });
      setMsg('Saved.');
    } catch (err) { setError((err as Error).message); }
  };
  return (
    <>
    <form className="card stack" style={{ maxWidth: 480 }} onSubmit={submit}>
      <div className="field"><label htmlFor="email">Email</label><input id="email" value={email ?? customer.email} readOnly /></div>
      <div className="field"><label htmlFor="fullName">Full name</label><input id="fullName" name="fullName" defaultValue={customer.fullName} required minLength={2} /></div>
      <div className="field"><label htmlFor="phone">Phone</label><input id="phone" name="phone" type="tel" defaultValue={customer.phone ?? ''} /></div>
      <label className="row" style={{ fontWeight: 400 }}><input type="checkbox" name="marketing" defaultChecked={customer.marketingOptIn} style={{ width: 'auto', minHeight: 0 }} /> Email me about new arrivals and offers</label>
      {error && <p className="err" role="alert">{error}</p>}
      {msg && <p className="ok" role="status">{msg}</p>}
      <button className="btn">Save changes</button>
    </form>
    <PushToggle />
    </>
  );
}
