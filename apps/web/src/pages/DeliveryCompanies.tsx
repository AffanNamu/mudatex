import { useState, type FormEvent } from 'react';
import { ErrorBanner, Field, Loading, Notice, PageHeader } from '../components/ui';
import { api, apiBase } from '../lib/api';
import { useLoad } from '../lib/hooks';

export interface Carrier {
  id: string; key: string; name: string; kind: 'manual' | 'webhook' | 'api'; adapter: string | null; trackingUrl: string | null; active: boolean;
  statusMap: Record<string, string>; hasCredentials: boolean; hasWebhookSecret: boolean; webhookPath: string;
}

const KIND: Record<Carrier['kind'], string> = { manual: 'Staff enter the tracking number and updates', webhook: 'The company sends us updates', api: 'Connected by a Mudatex connector' };
const OURS = 'booked, picked_up, in_transit, out_for_delivery, delivered, failed, returned, cancelled';

const mapToText = (m: Record<string, string>) => Object.entries(m).map(([k, v]) => `${k} = ${v}`).join('\n');
function textToMap(t: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of t.split('\n')) {
    const [k, v] = line.split('=').map((x) => x.trim());
    if (k && v) out[k.toLowerCase()] = v;
  }
  return out;
}

/** The delivery companies the business hands parcels to. Mudatex does not deliver: it passes the parcel on and follows it. */
export function DeliveryCompanies() {
  const list = useLoad<Carrier[]>('/v1/carriers');
  const adapters = useLoad<{ key: string; books: boolean; tracks: boolean }[]>('/v1/carrier-adapters');
  const [error, setError] = useState<unknown>(null);
  const [secret, setSecret] = useState<{ name: string; secret: string; path: string } | null>(null);
  const [adding, setAdding] = useState(false);

  return (
    <>
      <PageHeader title="Delivery companies"><button className="btn btn-primary" onClick={() => setAdding(!adding)} aria-expanded={adding}>{adding ? 'Close' : 'Add a delivery company'}</button></PageHeader>
      <p className="muted">Mudatex does not carry parcels. When an order is sent you choose the delivery company; the customer then follows the parcel on their order page, using the updates the company sends or you enter.</p>
      <ErrorBanner error={list.error ?? error} />
      {secret && (
        <Notice tone="warn">
          <strong>{secret.name}: signing secret (shown once).</strong> Give the delivery company, or the tracking service that watches their parcels for you, this address and secret: <code>{apiBase()}{secret.path}</code> and <code>{secret.secret}</code>.
          They sign each call with it: HMAC-SHA256 of the exact body, in the <code>X-Mudatex-Signature</code> header. See docs/operations/DELIVERY.md.
          <button className="link" onClick={() => setSecret(null)}> I have saved it</button>
        </Notice>
      )}
      {adding && <AddCarrier adapters={adapters.data ?? []} onDone={(c, s) => { setAdding(false); list.reload(); if (s) setSecret({ name: c.name, secret: s, path: c.webhookPath }); }} />}
      {list.loading && !list.data ? <Loading what="delivery companies" /> : (list.data ?? []).length === 0 && <Notice>No delivery company yet. Until you add one, orders can still be sent with a courier name typed by hand.</Notice>}
      <ul className="plain">
        {(list.data ?? []).map((c) => <li key={c.id}><CarrierCard c={c} onChanged={list.reload} onSecret={(s) => setSecret({ name: c.name, secret: s, path: c.webhookPath })} /></li>)}
      </ul>
    </>
  );
}

function AddCarrier({ adapters, onDone }: { adapters: { key: string }[]; onDone(c: Carrier, secret?: string): void }) {
  const [name, setName] = useState(''); const [key, setKey] = useState(''); const [kind, setKind] = useState<Carrier['kind']>('manual');
  const [url, setUrl] = useState(''); const [map, setMap] = useState(''); const [adapter, setAdapter] = useState(''); const [creds, setCreds] = useState('');
  const [error, setError] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      const credentials = Object.fromEntries(creds.split('\n').map((l) => l.split('=').map((x) => x.trim())).filter(([k, v]) => k && v) as [string, string][]);
      const r = await api<Carrier & { secret?: string }>('/v1/carriers', { method: 'POST', body: {
        key: key.trim() || name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''), name: name.trim(), kind,
        ...(url.trim() ? { trackingUrl: url.trim() } : {}), statusMap: textToMap(map),
        ...(kind === 'api' ? { adapter, ...(Object.keys(credentials).length ? { credentials } : {}) } : {}),
      } });
      onDone(r, r.secret);
    } catch (err) { setError(err); } finally { setBusy(false); }
  };
  return (
    <form className="panel form-grid" onSubmit={submit} aria-label="New delivery company">
      <Field label="Name"><input required minLength={2} maxLength={80} value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="Short key" hint="Lower-case letters and digits; made from the name if left empty"><input value={key} onChange={(e) => setKey(e.target.value)} pattern="[a-z0-9][a-z0-9-]{0,39}" /></Field>
      <Field label="How do updates arrive?">
        <select value={kind} onChange={(e) => setKind(e.target.value as Carrier['kind'])}>{(Object.keys(KIND) as Carrier['kind'][]).map((k) => <option key={k} value={k}>{KIND[k]}</option>)}</select>
      </Field>
      <Field label="Their tracking page" hint="Starts with https:// and has {ref} where the tracking number goes, e.g. https://example.com/track?no={ref}"><input type="url" value={url} onChange={(e) => setUrl(e.target.value)} /></Field>
      {kind !== 'manual' && <Field label="Their words for each stage" hint={`One per line: their word = ours. Ours: ${OURS}`}><textarea rows={4} value={map} onChange={(e) => setMap(e.target.value)} placeholder={'shipment picked = picked_up\nout for delivery = out_for_delivery'} /></Field>}
      {kind === 'api' && <>
        <Field label="Connector" hint={adapters.length ? undefined : 'No connectors are installed yet. They are added to Mudatex by its developers once the delivery company\'s API details are known.'}>
          <select required value={adapter} onChange={(e) => setAdapter(e.target.value)}><option value="">Choose…</option>{adapters.map((a) => <option key={a.key} value={a.key}>{a.key}</option>)}</select>
        </Field>
        <Field label="Credentials" hint="One per line: name = value, as the connector asks. Stored encrypted and never shown again."><textarea rows={3} value={creds} onChange={(e) => setCreds(e.target.value)} autoComplete="off" /></Field>
      </>}
      <div className="form-actions"><button className="btn btn-primary" disabled={busy || name.trim().length < 2}>Add</button></div>
      <ErrorBanner error={error} />
    </form>
  );
}

function CarrierCard({ c, onChanged, onSecret }: { c: Carrier; onChanged(): void; onSecret(s: string): void }) {
  const [map, setMap] = useState(mapToText(c.statusMap)); const [url, setUrl] = useState(c.trackingUrl ?? '');
  const [error, setError] = useState<unknown>(null); const [ok, setOk] = useState('');
  const run = async (fn: () => Promise<unknown>, done: string) => { setError(null); setOk(''); try { await fn(); setOk(done); onChanged(); } catch (e) { setError(e); } };
  return (
    <article className="panel" aria-label={c.name}>
      <h2>{c.name} <span className="chip">{c.active ? KIND[c.kind] : 'Switched off'}</span></h2>
      <p className="muted small">{c.kind === 'webhook' && <>Updates are sent to <code>{apiBase()}{c.webhookPath}</code>. </>}{c.kind === 'api' && <>Connector: {c.adapter}{c.hasCredentials ? ', credentials saved' : ''}. </>}{c.trackingUrl ? `Tracking page: ${c.trackingUrl}` : 'No tracking page.'}</p>
      <details><summary>Settings</summary>
        <form className="form-grid" onSubmit={(e) => { e.preventDefault(); void run(() => api(`/v1/carriers/${c.id}`, { method: 'PUT', body: { trackingUrl: url.trim() || null, ...(c.kind !== 'manual' ? { statusMap: textToMap(map) } : {}) } }), 'Saved.'); }}>
          <Field label="Their tracking page"><input type="url" value={url} onChange={(e) => setUrl(e.target.value)} /></Field>
          {c.kind !== 'manual' && <Field label="Their words for each stage" hint={`their word = ours. Ours: ${OURS}`}><textarea rows={4} value={map} onChange={(e) => setMap(e.target.value)} /></Field>}
          <div className="form-actions"><button className="btn btn-primary">Save</button></div>
        </form>
      </details>
      <div className="row-end">
        {c.kind === 'webhook' && <button className="btn" onClick={() => { if (window.confirm('Make a new secret? The old one stops working at once, so the delivery company must be given the new one.')) void run(async () => { onSecret((await api<{ secret: string }>(`/v1/carriers/${c.id}/rotate-secret`, { method: 'POST' })).secret); }, 'New secret made.'); }}>New secret</button>}
        <button className="btn" onClick={() => void run(() => api(`/v1/carriers/${c.id}`, { method: 'PUT', body: { active: !c.active } }), c.active ? 'Switched off.' : 'Switched on.')}>{c.active ? 'Switch off' : 'Switch on'}</button>
      </div>
      <ErrorBanner error={error} />{ok && <Notice tone="ok">{ok}</Notice>}
    </article>
  );
}
