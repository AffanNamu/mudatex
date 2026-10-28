'use client';

import { useEffect, useState } from 'react';
import { shopRequest } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useCart } from '@/lib/cart';

const toKey = (b64: string) => {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

/** Lets a shopper ask for order updates on this phone or browser, and turn them off again. */
export function PushToggle() {
  const { store } = useCart();
  const { token } = useAuth();
  const [supported, setSupported] = useState(false);
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    const ok = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && !!store.pushKey;
    setSupported(ok);
    if (!ok) return;
    navigator.serviceWorker.ready.then((reg) => reg.pushManager.getSubscription()).then((sub) => setOn(!!sub && Notification.permission === 'granted')).catch(() => undefined);
  }, [store.pushKey]);

  if (!supported || !token) return null;

  const turnOn = async () => {
    setBusy(true); setMessage('');
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') { setMessage('Notifications are blocked for this site. You can allow them in your browser settings.'); return; }
      const reg = await navigator.serviceWorker.ready;
      const sub = (await reg.pushManager.getSubscription()) ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toKey(store.pushKey!) });
      const json = sub.toJSON();
      await shopRequest('/me/push', { method: 'PUT', token, body: { endpoint: json.endpoint, keys: json.keys } });
      setOn(true);
    } catch (e) { setMessage((e as Error).message || 'Could not turn notifications on.'); } finally { setBusy(false); }
  };
  const turnOff = async () => {
    setBusy(true); setMessage('');
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) { await shopRequest('/me/push', { method: 'DELETE', token, body: { endpoint: sub.endpoint } }); await sub.unsubscribe(); }
      setOn(false);
    } catch (e) { setMessage((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <section className="card stack" style={{ maxWidth: 480, marginTop: 16 }} aria-labelledby="notif">
      <h2 id="notif">Order updates on this device</h2>
      <p className="muted">Get a notification when your order is paid, on its way and delivered.</p>
      {message && <p className="err" role="alert">{message}</p>}
      {on ? <button className="btn ghost" onClick={turnOff} disabled={busy}>Turn off notifications</button> : <button className="btn" onClick={turnOn} disabled={busy}>Turn on notifications</button>}
      {on && <p className="ok small" role="status">Notifications are on for this device.</p>}
    </section>
  );
}
