'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { shopRequest } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import type { Address } from '@/lib/types';

export default function Addresses() {
  const { token } = useAuth();
  const [list, setList] = useState<Address[] | null>(null);
  const [error, setError] = useState('');
  const load = () => { if (token) shopRequest<Address[]>('/me/addresses', { token }).then(setList).catch(() => setList([])); };
  useEffect(load, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  const add = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const g = (k: string) => String(f.get(k) ?? '').trim();
    setError('');
    try {
      await shopRequest('/me/addresses', { token: token!, body: { label: g('label') || 'Home', recipient: g('recipient'), phone: g('phone'), line1: g('line1'), line2: g('line2') || null, city: g('city'), state: g('state'), countryCode: g('countryCode') } });
      form.reset(); load();
    } catch (err) { setError((err as Error).message); }
  };
  const act = async (id: string, method: 'DELETE' | 'PUT', a?: Address) => {
    try {
      await shopRequest(`/me/addresses/${id}`, { token: token!, method, ...(a ? { body: { ...a, isDefault: true } } : {}) });
      load();
    } catch (err) { setError((err as Error).message); }
  };

  return (
    <div className="cartgrid">
      <div className="stack">
        {list === null && <p className="muted" role="status">Loading…</p>}
        {list?.length === 0 && <p className="muted">You haven&apos;t saved an address yet.</p>}
        {list?.map((a) => (
          <div className="card" key={a.id}>
            <div className="row spread"><strong>{a.label}{a.isDefault && <span className="status" style={{ marginLeft: 8 }}>Default</span>}</strong>
              <span className="row">{!a.isDefault && <button className="link small" onClick={() => act(a.id, 'PUT', a)}>Make default</button>}<button className="link small" onClick={() => confirm('Remove this address?') && act(a.id, 'DELETE')}>Remove</button></span></div>
            <p className="muted small" style={{ margin: 0 }}>{a.recipient} · {a.phone}<br />{a.line1}{a.line2 ? `, ${a.line2}` : ''}, {a.city}, {a.state}, {a.countryCode}</p>
          </div>
        ))}
      </div>
      <form className="card stack" onSubmit={add}>
        <h2>Add an address</h2>
        <div className="field"><label htmlFor="a-label">Label</label><input id="a-label" name="label" placeholder="Home, Shop…" /></div>
        <div className="field"><label htmlFor="a-rec">Recipient</label><input id="a-rec" name="recipient" required /></div>
        <div className="field"><label htmlFor="a-phone">Phone</label><input id="a-phone" name="phone" type="tel" required /></div>
        <div className="field"><label htmlFor="a-l1">Address</label><input id="a-l1" name="line1" required /></div>
        <div className="field"><label htmlFor="a-l2">Landmark (optional)</label><input id="a-l2" name="line2" /></div>
        <div className="grid2"><div className="field"><label htmlFor="a-city">City</label><input id="a-city" name="city" required /></div><div className="field"><label htmlFor="a-state">State</label><input id="a-state" name="state" required /></div></div>
        <div className="field"><label htmlFor="a-cc">Country</label><select id="a-cc" name="countryCode" defaultValue="NG"><option value="NG">Nigeria</option><option value="GH">Ghana</option><option value="NE">Niger</option><option value="CM">Cameroon</option><option value="TD">Chad</option></select></div>
        {error && <p className="err" role="alert">{error}</p>}
        <button className="btn">Save address</button>
      </form>
    </div>
  );
}
