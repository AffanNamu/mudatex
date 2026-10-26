import { useMemo, useState, type FormEvent } from 'react';
import { ErrorBanner, Field, Loading, Notice, PageHeader } from '../components/ui';
import { api } from '../lib/api';
import { useLoad } from '../lib/hooks';
import type { Product } from './Catalogue';

interface Storefront {
  id: string; legalEntityId: string; slug: string; name: string; priceListId: string; currency: string; stockLocationIds: string[];
  status: 'draft' | 'live' | 'closed'; tagline: string | null; publishedProducts: number;
  contact: { whatsapp?: string; phone?: string; email?: string; address?: string; bankName?: string; accountName?: string; accountNumber?: string };
}
interface Dept { id: string; slug: string; name: string; imageUrl: string | null; sort: number }
interface Published { productId: string; productName: string; slug: string; title: string; brand: string | null; departmentId: string | null; images: string[]; badges: string[]; published: boolean; priced: boolean }
interface Zone { id: string; name: string; countryCode: string; states: string[]; feeMinor: number; freeOverMinor: number | null; etaDaysMin: number; etaDaysMax: number; active: boolean }
interface Entity { id: string; name: string; functionalCurrency: string }
interface Place { id: string; legalEntityId: string; type: string; name: string }
interface PriceList { id: string; legalEntityId: string; name: string; currency: string }

const slugify = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
const minorOf = (text: string) => Math.round(Number(text) * 100);

function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [ok, setOk] = useState('');
  return {
    busy, error, ok,
    run: async (fn: () => Promise<unknown>, message: string, after?: () => void) => {
      setBusy(true); setError(null); setOk('');
      try { await fn(); setOk(message); after?.(); } catch (e) { setError(e); } finally { setBusy(false); }
    },
  };
}

/** The customer-facing shop: what is sold online, where from, at what price list, and what delivery costs. */
export function Store() {
  const stores = useLoad<Storefront[]>('/v1/storefronts');
  const [pick, setPick] = useState('');
  const list = stores.data ?? [];
  const store = list.find((s) => s.id === pick) ?? list[0];
  return (
    <>
      <PageHeader title="Online store">
        {list.length > 1 && <label className="field inline"><span className="field-label">Store</span><select value={store?.id} onChange={(e) => setPick(e.target.value)}>{list.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>}
      </PageHeader>
      <ErrorBanner error={stores.error} />
      {stores.loading && !stores.data && <Loading what="your store" />}
      {!stores.loading && !store && <Notice>You have no online store yet. Create one below.</Notice>}
      {store && <StoreEditor key={store.id} store={store} onChanged={stores.reload} />}
      <NewStore onDone={stores.reload} />
    </>
  );
}

function NewStore({ onDone }: { onDone(): void }) {
  const entities = useLoad<Entity[]>('/v1/legal-entities');
  const places = useLoad<Place[]>('/v1/locations');
  const lists = useLoad<PriceList[]>('/v1/pricing/price-lists');
  const [entityId, setEntityId] = useState(''); const [name, setName] = useState(''); const [slug, setSlug] = useState(''); const [listId, setListId] = useState(''); const [locs, setLocs] = useState<string[]>([]);
  const a = useAction();
  const ents = entities.data ?? [];
  const entity = entityId || ents[0]?.id || '';
  const myLists = (lists.data ?? []).filter((l) => l.legalEntityId === entity);
  const myPlaces = (places.data ?? []).filter((p) => p.legalEntityId === entity && ['branch', 'warehouse', 'storage_location'].includes(p.type));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    return a.run(() => api('/v1/storefronts', { method: 'POST', body: { legalEntityId: entity, slug: slug || slugify(name), name: name.trim(), priceListId: listId || myLists[0]!.id, stockLocationIds: locs.length ? locs : [myPlaces[0]!.id] } }), `Created “${name.trim()}”. Now add departments, publish products and set delivery.`, () => { setName(''); setSlug(''); onDone(); });
  };
  return (
    <details className="panel"><summary>Create a store</summary>
      <form className="form-grid" onSubmit={submit}>
        <Field label="Company"><select value={entity} onChange={(e) => { setEntityId(e.target.value); setLocs([]); setListId(''); }}>{ents.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></Field>
        <Field label="Store name"><input required value={name} onChange={(e) => setName(e.target.value)} maxLength={100} /></Field>
        <Field label="Web name" hint="Used in the address and by the website. Lower-case letters, digits, dashes."><input value={slug || slugify(name)} onChange={(e) => setSlug(e.target.value)} pattern="[a-z0-9]+(-[a-z0-9]+)*" /></Field>
        <Field label="Price list" hint="The online shop charges exactly the prices on this list."><select value={listId || myLists[0]?.id || ''} onChange={(e) => setListId(e.target.value)}>{myLists.map((l) => <option key={l.id} value={l.id}>{l.name} ({l.currency})</option>)}</select></Field>
        <fieldset className="field"><legend className="field-label">Sell stock from</legend>
          {myPlaces.map((p) => <label key={p.id} className="check"><input type="checkbox" checked={locs.includes(p.id) || (!locs.length && p.id === myPlaces[0]?.id)} onChange={(e) => setLocs(e.target.checked ? [...locs.filter(Boolean), p.id] : locs.filter((x) => x !== p.id))} /> {p.name}</label>)}
        </fieldset>
        <div className="form-actions"><button className="btn btn-primary" disabled={a.busy || !name || !myLists.length || !myPlaces.length}>Create store</button></div>
      </form>
      {!myLists.length && <Notice>This company has no price list yet. Create one in Business setup first.</Notice>}
      <ErrorBanner error={a.error} />{a.ok && <Notice tone="ok">{a.ok}</Notice>}
    </details>
  );
}

function StoreEditor({ store, onChanged }: { store: Storefront; onChanged(): void }) {
  return (
    <>
      <Status store={store} onChanged={onChanged} />
      <Details store={store} onChanged={onChanged} />
      <Departments storeId={store.id} />
      <Publishing store={store} onChanged={onChanged} />
      <Delivery storeId={store.id} />
    </>
  );
}

function Status({ store, onChanged }: { store: Storefront; onChanged(): void }) {
  const a = useAction();
  const set = (status: Storefront['status']) => a.run(() => api(`/v1/storefronts/${store.id}`, { method: 'PUT', body: { status } }), `Store is now ${status}.`, onChanged);
  return (
    <section className="panel" aria-label="Store status">
      <h2>{store.name} <span className={`chip ${store.status === 'live' ? 'chip-on' : ''}`}>{store.status}</span></h2>
      <p className="muted">Web name: <code>{store.slug}</code> · {store.publishedProducts} published product{store.publishedProducts === 1 ? '' : 's'}. {store.status !== 'live' && 'Shoppers cannot see the store until it is live.'}</p>
      <div className="row">
        {store.status !== 'live' ? <button className="btn btn-primary" disabled={a.busy} onClick={() => set('live')}>Go live</button> : <button className="btn" disabled={a.busy} onClick={() => set('closed')}>Close the store</button>}
      </div>
      <ErrorBanner error={a.error} />{a.ok && <Notice tone="ok">{a.ok}</Notice>}
    </section>
  );
}

function Details({ store, onChanged }: { store: Storefront; onChanged(): void }) {
  const c = store.contact;
  const [tag, setTag] = useState(store.tagline ?? ''); const [wa, setWa] = useState(c.whatsapp ?? ''); const [phone, setPhone] = useState(c.phone ?? ''); const [email, setEmail] = useState(c.email ?? '');
  const [address, setAddress] = useState(c.address ?? ''); const [bank, setBank] = useState(c.bankName ?? ''); const [accName, setAccName] = useState(c.accountName ?? ''); const [accNo, setAccNo] = useState(c.accountNumber ?? '');
  const a = useAction();
  const clean = (v: string) => v.trim() || undefined;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const contact = Object.fromEntries(Object.entries({ whatsapp: clean(wa.replace(/[\s()-]/g, '')), phone: clean(phone), email: clean(email), address: clean(address), bankName: clean(bank), accountName: clean(accName), accountNumber: clean(accNo) }).filter(([, v]) => v));
    return a.run(() => api(`/v1/storefronts/${store.id}`, { method: 'PUT', body: { tagline: tag.trim() || null, contact } }), 'Saved.', onChanged);
  };
  return (
    <details className="panel"><summary>Contact and bank-transfer details</summary>
      <form className="form-grid" onSubmit={submit}>
        <Field label="Tagline" hint="Shown in the banner at the top of the website"><input value={tag} onChange={(e) => setTag(e.target.value)} maxLength={200} /></Field>
        <Field label="WhatsApp number" hint="With country code, e.g. +2348012345678"><input value={wa} onChange={(e) => setWa(e.target.value)} /></Field>
        <Field label="Phone"><input value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
        <Field label="Email"><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field label="Address"><input value={address} onChange={(e) => setAddress(e.target.value)} maxLength={300} /></Field>
        <Field label="Bank"><input value={bank} onChange={(e) => setBank(e.target.value)} /></Field>
        <Field label="Account name"><input value={accName} onChange={(e) => setAccName(e.target.value)} /></Field>
        <Field label="Account number"><input inputMode="numeric" value={accNo} onChange={(e) => setAccNo(e.target.value)} pattern="[0-9]{6,20}" /></Field>
        <div className="form-actions"><button className="btn btn-primary" disabled={a.busy}>Save details</button></div>
      </form>
      <ErrorBanner error={a.error} />{a.ok && <Notice tone="ok">{a.ok}</Notice>}
    </details>
  );
}

function Departments({ storeId }: { storeId: string }) {
  const depts = useLoad<Dept[]>(`/v1/storefronts/${storeId}/departments`);
  const [name, setName] = useState(''); const [image, setImage] = useState('');
  const a = useAction();
  const add = (e: FormEvent) => { e.preventDefault(); return a.run(() => api(`/v1/storefronts/${storeId}/departments`, { method: 'POST', body: { slug: slugify(name), name: name.trim(), imageUrl: image.trim() || null, sort: (depts.data?.length ?? 0) * 10 } }), `Added ${name.trim()}.`, () => { setName(''); setImage(''); depts.reload(); }); };
  const del = (d: Dept) => a.run(() => api(`/v1/storefronts/${storeId}/departments/${d.id}`, { method: 'DELETE' }), `Removed ${d.name}.`, depts.reload);
  return (
    <section className="panel" aria-label="Departments"><h2>Departments</h2>
      <ErrorBanner error={depts.error} />
      <p>{(depts.data ?? []).map((d) => <span key={d.id} className="chip">{d.name} <button type="button" className="btn btn-ghost" aria-label={`Remove ${d.name}`} onClick={() => del(d)}>×</button></span>)}{depts.data?.length === 0 && <span className="muted">No departments yet — e.g. Lace, Ankara, Brocade, Atampa.</span>}</p>
      <form className="form-grid" onSubmit={add}>
        <Field label="New department"><input required value={name} onChange={(e) => setName(e.target.value)} maxLength={80} /></Field>
        <Field label="Picture (https link, optional)"><input type="url" value={image} onChange={(e) => setImage(e.target.value)} placeholder="https://…" /></Field>
        <div className="form-actions"><button className="btn btn-primary" disabled={a.busy || !slugify(name)}>Add</button></div>
      </form>
      <ErrorBanner error={a.error} />{a.ok && <Notice tone="ok">{a.ok}</Notice>}
    </section>
  );
}

function Publishing({ store, onChanged }: { store: Storefront; onChanged(): void }) {
  const rows = useLoad<Published[]>(`/v1/storefronts/${store.id}/products`);
  const products = useLoad<Product[]>('/v1/products?limit=200');
  const depts = useLoad<Dept[]>(`/v1/storefronts/${store.id}/departments`);
  const [editing, setEditing] = useState<string | null>(null);
  const a = useAction();
  const byId = useMemo(() => new Map((rows.data ?? []).map((r) => [r.productId, r])), [rows.data]);
  const refresh = () => { rows.reload(); onChanged(); };
  const toggle = (productId: string, published: boolean) => a.run(() => api(`/v1/storefronts/${store.id}/products/${productId}`, { method: 'PUT', body: { published } }), published ? 'Published.' : 'Hidden from the store.', refresh);
  return (
    <section className="panel" aria-label="Products"><h2>Products sold online</h2>
      <p className="muted">Only published products with a current price appear in the shop.</p>
      <ErrorBanner error={rows.error ?? products.error ?? a.error} />{a.ok && <Notice tone="ok">{a.ok}</Notice>}
      <div className="table-wrap"><table>
        <thead><tr><th scope="col">Product</th><th scope="col">Online</th><th scope="col">Price</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>
          {(products.data ?? []).filter((p) => p.status === 'active').map((p) => {
            const r = byId.get(p.id);
            return (
              <tr key={p.id}>
                <th scope="row">{r?.title ?? p.name}{r && r.title !== p.name && <div className="muted">{p.name}</div>}</th>
                <td>{r?.published ? 'Published' : r ? 'Draft' : 'Not listed'}</td>
                <td>{r ? (r.priced ? 'Priced' : <span className="field-error">No current price</span>) : '—'}</td>
                <td>
                  <button className="btn" onClick={() => setEditing(editing === p.id ? null : p.id)}>{r ? 'Edit' : 'Add to store'}</button>{' '}
                  {r && <button className="btn" disabled={a.busy || (!r.published && !r.priced)} onClick={() => toggle(p.id, !r.published)}>{r.published ? 'Hide' : 'Publish'}</button>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table></div>
      {editing && <ProductForm key={editing} storeId={store.id} product={(products.data ?? []).find((p) => p.id === editing)!} existing={byId.get(editing)} depts={depts.data ?? []} onDone={() => { setEditing(null); refresh(); }} />}
    </section>
  );
}

function ProductForm({ storeId, product, existing, depts, onDone }: { storeId: string; product: Product; existing?: Published; depts: Dept[]; onDone(): void }) {
  const [title, setTitle] = useState(existing?.title ?? product.name); const [slug, setSlug] = useState(existing?.slug ?? slugify(product.name));
  const [brand, setBrand] = useState(existing?.brand ?? ''); const [dept, setDept] = useState(existing?.departmentId ?? '');
  const [images, setImages] = useState((existing?.images ?? []).join('\n')); const [badges, setBadges] = useState((existing?.badges ?? []).join(', '));
  const [desc, setDesc] = useState(''); const [published, setPublished] = useState(existing?.published ?? false);
  const a = useAction();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    return a.run(() => api(`/v1/storefronts/${storeId}/products/${product.id}`, { method: 'PUT', body: {
      title: title.trim(), slug, brand: brand.trim() || null, departmentId: dept || null,
      images: images.split('\n').map((s) => s.trim()).filter(Boolean), badges: badges.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 6),
      ...(desc.trim() ? { description: desc.trim() } : {}), published,
    } }), 'Saved.', onDone);
  };
  return (
    <form className="panel form-grid" onSubmit={submit} aria-label={`Online listing for ${product.name}`}>
      <h3>{product.name}</h3>
      <Field label="Title shown to shoppers"><input required value={title} onChange={(e) => setTitle(e.target.value)} maxLength={160} /></Field>
      <Field label="Web address" hint="Lower-case letters, digits, dashes"><input required value={slug} onChange={(e) => setSlug(e.target.value)} pattern="[a-z0-9]+(-[a-z0-9]+)*" /></Field>
      <Field label="Brand"><input value={brand} onChange={(e) => setBrand(e.target.value)} maxLength={80} placeholder="Empire Atampa, Florance…" /></Field>
      <Field label="Department"><select value={dept} onChange={(e) => setDept(e.target.value)}><option value="">None</option>{depts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>
      <Field label="Picture links (https), one per line" hint="The first is the main picture"><textarea rows={3} value={images} onChange={(e) => setImages(e.target.value)} /></Field>
      <Field label="Badges" hint="Comma separated, up to 6, e.g. New, Best seller"><input value={badges} onChange={(e) => setBadges(e.target.value)} /></Field>
      <Field label="Description" hint={existing ? 'Leave empty to keep the current description' : 'Defaults to the catalogue description'}><textarea rows={4} value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={5000} /></Field>
      <label className="field"><span className="field-label">Visible in the shop</span><input type="checkbox" checked={published} onChange={(e) => setPublished(e.target.checked)} /></label>
      <div className="form-actions"><button className="btn btn-primary" disabled={a.busy}>Save listing</button> <button type="button" className="btn" onClick={onDone}>Cancel</button></div>
      <ErrorBanner error={a.error} />
    </form>
  );
}

function Delivery({ storeId }: { storeId: string }) {
  const zones = useLoad<Zone[]>(`/v1/storefronts/${storeId}/delivery-zones`);
  const [name, setName] = useState(''); const [country, setCountry] = useState('NG'); const [states, setStates] = useState(''); const [fee, setFee] = useState('');
  const [free, setFree] = useState(''); const [min, setMin] = useState('1'); const [max, setMax] = useState('3');
  const a = useAction();
  const add = (e: FormEvent) => {
    e.preventDefault();
    return a.run(() => api(`/v1/storefronts/${storeId}/delivery-zones`, { method: 'POST', body: {
      name: name.trim(), countryCode: country, states: states.split(',').map((s) => s.trim()).filter(Boolean), feeMinor: minorOf(fee || '0'),
      ...(free ? { freeOverMinor: minorOf(free) } : {}), etaDaysMin: Number(min), etaDaysMax: Number(max),
    } }), `Added ${name.trim()}.`, () => { setName(''); setStates(''); setFee(''); setFree(''); zones.reload(); });
  };
  const money = (m: number) => (m / 100).toLocaleString(undefined, { minimumFractionDigits: 2 });
  const remove = (z: Zone) => a.run(() => api(`/v1/storefronts/${storeId}/delivery-zones/${z.id}`, { method: 'DELETE' }), `Removed ${z.name}.`, zones.reload);
  return (
    <section className="panel" aria-label="Delivery"><h2>Delivery zones</h2>
      <ErrorBanner error={zones.error} />
      <div className="table-wrap"><table>
        <thead><tr><th scope="col">Zone</th><th scope="col">Where</th><th scope="col">Fee</th><th scope="col">Free over</th><th scope="col">Days</th><th scope="col"><span className="sr-only">Remove</span></th></tr></thead>
        <tbody>
          {(zones.data ?? []).map((z) => <tr key={z.id}><th scope="row">{z.name}</th><td>{z.countryCode}{z.states.length ? `: ${z.states.join(', ')}` : ' (whole country)'}</td><td>{money(z.feeMinor)}</td><td>{z.freeOverMinor ? money(z.freeOverMinor) : '—'}</td><td>{z.etaDaysMin}–{z.etaDaysMax}</td><td><button className="btn" onClick={() => remove(z)}>Remove</button></td></tr>)}
          {zones.data?.length === 0 && <tr><td colSpan={6} className="muted">No delivery zones — shoppers cannot check out until you add one.</td></tr>}
        </tbody>
      </table></div>
      <form className="form-grid" onSubmit={add}>
        <Field label="Zone name"><input required value={name} onChange={(e) => setName(e.target.value)} placeholder="Kano & Kaduna" /></Field>
        <Field label="Country code"><input required value={country} onChange={(e) => setCountry(e.target.value.toUpperCase())} pattern="[A-Z]{2}" maxLength={2} /></Field>
        <Field label="States" hint="Comma separated. Leave empty for the whole country."><input value={states} onChange={(e) => setStates(e.target.value)} placeholder="Kano, Kaduna" /></Field>
        <Field label="Delivery fee"><input required inputMode="decimal" value={fee} onChange={(e) => setFee(e.target.value)} /></Field>
        <Field label="Free delivery over" hint="Optional basket value"><input inputMode="decimal" value={free} onChange={(e) => setFree(e.target.value)} /></Field>
        <Field label="Days (from)"><input type="number" min={0} value={min} onChange={(e) => setMin(e.target.value)} /></Field>
        <Field label="Days (to)"><input type="number" min={0} value={max} onChange={(e) => setMax(e.target.value)} /></Field>
        <div className="form-actions"><button className="btn btn-primary" disabled={a.busy || !name}>Add zone</button></div>
      </form>
      <ErrorBanner error={a.error} />{a.ok && <Notice tone="ok">{a.ok}</Notice>}
    </section>
  );
}
