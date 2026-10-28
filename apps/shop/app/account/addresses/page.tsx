'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { shopRequest } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import type { Address } from '@/lib/types';

export default function Addresses() {
  const { token } = useAuth();
  const { t } = useI18n();
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
      await shopRequest('/me/addresses', { token: token!, body: { label: g('label') || t('addr.defaultLabel'), recipient: g('recipient'), phone: g('phone'), line1: g('line1'), line2: g('line2') || null, city: g('city'), state: g('state'), countryCode: g('countryCode') } });
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
        {list === null && <p className="muted" role="status">{t('loading')}</p>}
        {list?.length === 0 && <p className="muted">{t('addr.none')}</p>}
        {list?.map((a) => (
          <div className="card" key={a.id}>
            <div className="row spread"><strong>{a.label}{a.isDefault && <span className="status" style={{ marginLeft: 8 }}>{t('addr.default')}</span>}</strong>
              <span className="row">{!a.isDefault && <button className="link small" onClick={() => act(a.id, 'PUT', a)}>{t('addr.makeDefault')}</button>}<button className="link small" onClick={() => confirm(t('addr.confirmRemove')) && act(a.id, 'DELETE')}>{t('cart.remove')}</button></span></div>
            <p className="muted small" style={{ margin: 0 }}>{a.recipient} · {a.phone}<br />{a.line1}{a.line2 ? `, ${a.line2}` : ''}, {a.city}, {a.state}, {a.countryCode}</p>
          </div>
        ))}
      </div>
      <form className="card stack" onSubmit={add}>
        <h2>{t('addr.add')}</h2>
        <div className="field"><label htmlFor="a-label">{t('addr.label')}</label><input id="a-label" name="label" placeholder={t('addr.labelPh')} /></div>
        <div className="field"><label htmlFor="a-rec">{t('addr.recipient')}</label><input id="a-rec" name="recipient" required /></div>
        <div className="field"><label htmlFor="a-phone">{t('addr.phone')}</label><input id="a-phone" name="phone" type="tel" required /></div>
        <div className="field"><label htmlFor="a-l1">{t('addr.address')}</label><input id="a-l1" name="line1" required /></div>
        <div className="field"><label htmlFor="a-l2">{t('addr.landmarkShort')}</label><input id="a-l2" name="line2" /></div>
        <div className="grid2"><div className="field"><label htmlFor="a-city">{t('addr.city')}</label><input id="a-city" name="city" required /></div><div className="field"><label htmlFor="a-state">{t('addr.state')}</label><input id="a-state" name="state" required /></div></div>
        <div className="field"><label htmlFor="a-cc">{t('addr.country')}</label><select id="a-cc" name="countryCode" defaultValue="NG">{(['NG', 'GH', 'NE', 'CM', 'TD'] as const).map((c) => <option key={c} value={c}>{t(`country.${c}`)}</option>)}</select></div>
        {error && <p className="err" role="alert">{error}</p>}
        <button className="btn">{t('addr.save')}</button>
      </form>
    </div>
  );
}
