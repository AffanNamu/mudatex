import { useMemo, useState, type FormEvent } from 'react';
import { ErrorBanner, Field, Loading, Notice, PageHeader } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useLoad } from '../lib/hooks';
import type { Product, Unit } from './Catalogue';

interface Entity { id: string; name: string; countryCode: string; functionalCurrency: string; minorUnit: number }
interface Place { id: string; legalEntityId: string; type: string; name: string; countryCode: string; timezone: string }
interface TaxCode { id: string; legalEntityId: string; code: string; name: string; rate: string; priceInclusive: boolean }
interface PriceList { id: string; legalEntityId: string; name: string; currency: string }
interface Register { id: string; code: string; name: string; locationId: string; priceListId: string; maxDiscountBps: number }

const CURRENCIES = ['NGN', 'GHS', 'KES', 'ZAR', 'XOF', 'UGX', 'USD', 'EUR', 'GBP', 'AED', 'CNY', 'INR'];
const PLACE_TYPES = [['branch', 'Shop / branch'], ['warehouse', 'Warehouse'], ['storage_location', 'Storage location'], ['department', 'Department'], ['cost_centre', 'Cost centre']] as const;

/** Runs a create call and reloads the list; shows the failure instead of losing it. */
function useCreate(run: () => Promise<unknown>, after: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState('');
  return {
    busy, error, done,
    submit: async (e: FormEvent, label: string) => {
      e.preventDefault();
      setBusy(true); setError(null); setDone('');
      try { await run(); setDone(label); after(); } catch (err) { setError(err); } finally { setBusy(false); }
    },
  };
}

/** Everything the business needs configured before it can trade: companies, places, units, tax, prices, registers. */
export function Setup() {
  const { can } = useAuth();
  const entities = useLoad<Entity[]>('/v1/legal-entities');
  const places = useLoad<Place[]>('/v1/locations');
  const units = useLoad<Unit[]>('/v1/units');
  const taxes = useLoad<TaxCode[]>('/v1/pricing/tax-codes');
  const lists = useLoad<PriceList[]>('/v1/pricing/price-lists');
  const registers = useLoad<Register[]>('/v1/pos/registers');
  const products = useLoad<Product[]>('/v1/products?limit=200');
  const ents = entities.data ?? [];
  const entName = (id: string) => ents.find((e) => e.id === id)?.name ?? '—';
  const failure = entities.error ?? places.error ?? units.error ?? taxes.error ?? lists.error;

  return (
    <>
      <PageHeader title="Business setup" />
      <p className="muted">Set these up in order: company, places, units, tax, price list, prices, then till registers and the online store.</p>
      <ErrorBanner error={failure} />
      {entities.loading && !entities.data && <Loading what="your setup" />}

      <Section title="1. Companies" count={ents.length}>
        <Table head={['Company', 'Country', 'Currency']} rows={ents.map((e) => [e.name, e.countryCode, e.functionalCurrency])} />
        {can('org.manage') && <NewCompany onDone={entities.reload} />}
      </Section>

      <Section title="2. Shops, warehouses and other places" count={places.data?.length ?? 0}>
        <Table head={['Place', 'Type', 'Company', 'Country']} rows={(places.data ?? []).map((p) => [p.name, PLACE_TYPES.find((t) => t[0] === p.type)?.[1] ?? p.type, entName(p.legalEntityId), p.countryCode])} />
        {can('org.manage') && ents.length > 0 && <NewPlace entities={ents} onDone={places.reload} />}
      </Section>

      <Section title="3. Units of measure" count={units.data?.length ?? 0}>
        <Table head={['Code', 'Name', 'Kind', 'Decimals']} rows={(units.data ?? []).map((u) => [u.code, u.name, u.kind, String(u.precision)])} />
        {can('catalog.write') && <NewUnit onDone={units.reload} />}
        <p className="muted">Conversions (for example 1 roll = 50 m) are set when a product is created.</p>
      </Section>

      <Section title="4. Tax codes" count={taxes.data?.length ?? 0}>
        <Table head={['Code', 'Name', 'Rate', 'Price includes tax', 'Company']} rows={(taxes.data ?? []).map((t) => [t.code, t.name, `${(Number(t.rate) * 100).toFixed(2).replace(/\.?0+$/, '')}%`, t.priceInclusive ? 'Yes' : 'No', entName(t.legalEntityId)])} />
        {can('pricing.manage') && ents.length > 0 && <NewTax entities={ents} onDone={taxes.reload} />}
        <p className="muted">A tax code cannot be edited once created. For a new rate, create a new code. Confirm the rates with your tax adviser.</p>
      </Section>

      <Section title="5. Price lists and prices" count={lists.data?.length ?? 0}>
        <Table head={['Price list', 'Company', 'Currency']} rows={(lists.data ?? []).map((l) => [l.name, entName(l.legalEntityId), l.currency])} />
        {can('pricing.manage') && ents.length > 0 && <NewPriceList entities={ents} onDone={lists.reload} />}
        {can('pricing.manage') && (lists.data?.length ?? 0) > 0 && products.data && <SetPrice lists={lists.data!} taxes={taxes.data ?? []} products={products.data} />}
      </Section>

      <Section title="6. Till registers" count={registers.data?.length ?? 0}>
        <Table head={['Register', 'Place', 'Price list', 'Discount limit']} rows={(registers.data ?? []).map((r) => [`${r.code} · ${r.name}`, places.data?.find((p) => p.id === r.locationId)?.name ?? '—', lists.data?.find((l) => l.id === r.priceListId)?.name ?? '—', `${r.maxDiscountBps / 100}%`])} />
        {can('pos.register.manage') && (places.data?.length ?? 0) > 0 && (lists.data?.length ?? 0) > 0 && <NewRegister places={places.data!} lists={lists.data!} onDone={registers.reload} />}
      </Section>
    </>
  );
}

function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return <section className="panel" aria-label={title}><h2>{title} <span className="muted">({count})</span></h2>{children}</section>;
}

function Table({ head, rows }: { head: string[]; rows: string[][] }) {
  if (!rows.length) return <p className="muted">Nothing here yet.</p>;
  return (
    <div className="table-wrap"><table>
      <thead><tr>{head.map((h) => <th key={h} scope="col">{h}</th>)}</tr></thead>
      <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => (j === 0 ? <th scope="row" key={j}>{c}</th> : <td key={j}>{c}</td>))}</tr>)}</tbody>
    </table></div>
  );
}

function Result({ c }: { c: { error: unknown; done: string } }) {
  return <><ErrorBanner error={c.error} />{c.done && <Notice tone="ok">Created {c.done}.</Notice>}</>;
}

function NewCompany({ onDone }: { onDone(): void }) {
  const [name, setName] = useState(''); const [country, setCountry] = useState('NG'); const [currency, setCurrency] = useState('NGN');
  const c = useCreate(() => api('/v1/legal-entities', { method: 'POST', body: { name: name.trim(), countryCode: country.toUpperCase(), functionalCurrency: currency } }), () => { setName(''); onDone(); });
  return (
    <details><summary>Add a company</summary>
      <form className="form-grid" onSubmit={(e) => c.submit(e, name.trim())}>
        <Field label="Company name"><input required value={name} onChange={(e) => setName(e.target.value)} maxLength={200} /></Field>
        <Field label="Country code" hint="Two letters, e.g. NG"><input required value={country} onChange={(e) => setCountry(e.target.value)} pattern="[A-Za-z]{2}" maxLength={2} /></Field>
        <Field label="Currency"><select value={currency} onChange={(e) => setCurrency(e.target.value)}>{CURRENCIES.map((x) => <option key={x}>{x}</option>)}</select></Field>
        <div className="form-actions"><button className="btn btn-primary" disabled={c.busy || !name}>Add company</button></div>
      </form><Result c={c} />
    </details>
  );
}

function NewPlace({ entities, onDone }: { entities: Entity[]; onDone(): void }) {
  const [entity, setEntity] = useState(entities[0]!.id); const [type, setType] = useState('branch'); const [name, setName] = useState('');
  const e0 = entities.find((e) => e.id === entity) ?? entities[0]!;
  const [tz, setTz] = useState('Africa/Lagos');
  const c = useCreate(() => api('/v1/locations', { method: 'POST', body: { legalEntityId: entity, type, name: name.trim(), countryCode: e0.countryCode, timezone: tz } }), () => { setName(''); onDone(); });
  return (
    <details><summary>Add a place</summary>
      <form className="form-grid" onSubmit={(e) => c.submit(e, name.trim())}>
        <Field label="Company"><select value={entity} onChange={(e) => setEntity(e.target.value)}>{entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></Field>
        <Field label="Type"><select value={type} onChange={(e) => setType(e.target.value)}>{PLACE_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
        <Field label="Name"><input required value={name} onChange={(e) => setName(e.target.value)} maxLength={200} /></Field>
        <Field label="Time zone" hint="IANA name, e.g. Africa/Lagos"><input required value={tz} onChange={(e) => setTz(e.target.value)} /></Field>
        <div className="form-actions"><button className="btn btn-primary" disabled={c.busy || !name}>Add place</button></div>
      </form><Result c={c} />
    </details>
  );
}

function NewUnit({ onDone }: { onDone(): void }) {
  const [code, setCode] = useState(''); const [name, setName] = useState(''); const [kind, setKind] = useState('decimal'); const [precision, setPrecision] = useState('2');
  const c = useCreate(() => api('/v1/units', { method: 'POST', body: { code: code.trim(), name: name.trim(), kind, precision: kind === 'discrete' ? 0 : Number(precision) } }), () => { setCode(''); setName(''); onDone(); });
  return (
    <details><summary>Add a unit</summary>
      <form className="form-grid" onSubmit={(e) => c.submit(e, name.trim())}>
        <Field label="Code" hint="m, yd, roll, pcs…"><input required value={code} onChange={(e) => setCode(e.target.value)} maxLength={20} /></Field>
        <Field label="Name"><input required value={name} onChange={(e) => setName(e.target.value)} maxLength={100} /></Field>
        <Field label="Kind" hint="Whole items (rolls, pieces) or measured (metres, kilograms)"><select value={kind} onChange={(e) => setKind(e.target.value)}><option value="decimal">Measured</option><option value="discrete">Whole items</option></select></Field>
        {kind === 'decimal' && <Field label="Decimal places"><input type="number" min={0} max={6} value={precision} onChange={(e) => setPrecision(e.target.value)} /></Field>}
        <div className="form-actions"><button className="btn btn-primary" disabled={c.busy || !code || !name}>Add unit</button></div>
      </form><Result c={c} />
    </details>
  );
}

function NewTax({ entities, onDone }: { entities: Entity[]; onDone(): void }) {
  const [entity, setEntity] = useState(entities[0]!.id); const [code, setCode] = useState(''); const [name, setName] = useState(''); const [pct, setPct] = useState('7.5'); const [inclusive, setInclusive] = useState(false);
  const valid = /^\d{1,2}(\.\d{1,4})?$/.test(pct) && Number(pct) < 100;
  const c = useCreate(() => api('/v1/pricing/tax-codes', { method: 'POST', body: { legalEntityId: entity, code: code.trim().toUpperCase(), name: name.trim(), rate: (Number(pct) / 100).toFixed(6).replace(/0+$/, '').replace(/\.$/, '') || '0', priceInclusive: inclusive } }), () => { setCode(''); setName(''); onDone(); });
  return (
    <details><summary>Add a tax code</summary>
      <form className="form-grid" onSubmit={(e) => c.submit(e, code.toUpperCase())}>
        <Field label="Company"><select value={entity} onChange={(e) => setEntity(e.target.value)}>{entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></Field>
        <Field label="Code" hint="Capitals, digits and underscores, e.g. VAT75"><input required value={code} onChange={(e) => setCode(e.target.value)} pattern="[A-Za-z0-9_]{2,30}" /></Field>
        <Field label="Name"><input required value={name} onChange={(e) => setName(e.target.value)} maxLength={100} /></Field>
        <Field label="Rate (%)" error={valid ? null : 'Enter a percentage below 100'}><input required inputMode="decimal" value={pct} onChange={(e) => setPct(e.target.value)} /></Field>
        <label className="field"><span className="field-label">Prices already include this tax</span><input type="checkbox" checked={inclusive} onChange={(e) => setInclusive(e.target.checked)} /></label>
        <div className="form-actions"><button className="btn btn-primary" disabled={c.busy || !code || !name || !valid}>Add tax code</button></div>
      </form><Result c={c} />
    </details>
  );
}

function NewPriceList({ entities, onDone }: { entities: Entity[]; onDone(): void }) {
  const [entity, setEntity] = useState(entities[0]!.id); const [name, setName] = useState('');
  const currency = (entities.find((e) => e.id === entity) ?? entities[0]!).functionalCurrency;
  const c = useCreate(() => api('/v1/pricing/price-lists', { method: 'POST', body: { legalEntityId: entity, name: name.trim(), currency } }), () => { setName(''); onDone(); });
  return (
    <details><summary>Add a price list</summary>
      <form className="form-grid" onSubmit={(e) => c.submit(e, name.trim())}>
        <Field label="Company"><select value={entity} onChange={(e) => setEntity(e.target.value)}>{entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></Field>
        <Field label="Name" hint={`Prices are in ${currency}`}><input required value={name} onChange={(e) => setName(e.target.value)} maxLength={100} placeholder="Retail, Wholesale, Online…" /></Field>
        <div className="form-actions"><button className="btn btn-primary" disabled={c.busy || !name}>Add price list</button></div>
      </form><Result c={c} />
    </details>
  );
}

function SetPrice({ lists, taxes, products }: { lists: PriceList[]; taxes: TaxCode[]; products: Product[] }) {
  const [listId, setListId] = useState(lists[0]!.id); const [variantId, setVariantId] = useState(''); const [price, setPrice] = useState(''); const [taxId, setTaxId] = useState('');
  const list = lists.find((l) => l.id === listId) ?? lists[0]!;
  const variants = useMemo(() => products.filter((p) => p.status === 'active').flatMap((p) => p.variants.map((v) => ({ id: v.id, label: `${p.name} — ${v.sku}` }))), [products]);
  const eligibleTax = taxes.filter((t) => t.legalEntityId === list.legalEntityId);
  const valid = /^\d+(\.\d{1,4})?$/.test(price);
  const c = useCreate(() => api(`/v1/pricing/price-lists/${listId}/items`, { method: 'PUT', body: { variantId: variantId || variants[0]!.id, unitPrice: price, taxCodeId: taxId || null } }), () => setPrice(''));
  return (
    <details><summary>Set a price</summary>
      <form className="form-grid" onSubmit={(e) => c.submit(e, 'the price')}>
        <Field label="Price list"><select value={listId} onChange={(e) => { setListId(e.target.value); setTaxId(''); }}>{lists.map((l) => <option key={l.id} value={l.id}>{l.name} ({l.currency})</option>)}</select></Field>
        <Field label="Product"><select value={variantId || variants[0]?.id} onChange={(e) => setVariantId(e.target.value)}>{variants.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}</select></Field>
        <Field label={`Price per unit (${list.currency})`} error={price && !valid ? 'Digits with up to 4 decimals' : null}><input required inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} /></Field>
        <Field label="Tax"><select value={taxId} onChange={(e) => setTaxId(e.target.value)}><option value="">No tax</option>{eligibleTax.map((t) => <option key={t.id} value={t.id}>{t.code} — {t.name}</option>)}</select></Field>
        <div className="form-actions"><button className="btn btn-primary" disabled={c.busy || !valid || !variants.length}>Set price</button></div>
      </form><Result c={c} />
      <p className="muted">The new price starts now; the previous one ends at the same moment, so past sales stay explainable.</p>
    </details>
  );
}

function NewRegister({ places, lists, onDone }: { places: Place[]; lists: PriceList[]; onDone(): void }) {
  const shops = places.filter((p) => ['branch', 'warehouse', 'storage_location'].includes(p.type));
  const [loc, setLoc] = useState(shops[0]?.id ?? ''); const [code, setCode] = useState(''); const [name, setName] = useState(''); const [list, setList] = useState(''); const [disc, setDisc] = useState('5'); const [refund, setRefund] = useState('');
  const here = shops.find((p) => p.id === loc);
  const eligible = lists.filter((l) => l.legalEntityId === here?.legalEntityId);
  const c = useCreate(() => api('/v1/pos/registers', { method: 'POST', body: {
    locationId: loc, code: code.trim().toUpperCase(), name: name.trim(), priceListId: list || eligible[0]!.id,
    maxDiscountBps: Math.round(Number(disc) * 100), ...(refund ? { refundThresholdMinor: Math.round(Number(refund) * 100) } : {}),
  } }), () => { setCode(''); setName(''); onDone(); });
  if (!shops.length) return null;
  return (
    <details><summary>Add a register</summary>
      <form className="form-grid" onSubmit={(e) => c.submit(e, code.toUpperCase())}>
        <Field label="Place"><select value={loc} onChange={(e) => setLoc(e.target.value)}>{shops.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
        <Field label="Code" hint="2–10 capitals or digits"><input required value={code} onChange={(e) => setCode(e.target.value)} pattern="[A-Za-z0-9]{2,10}" /></Field>
        <Field label="Name"><input required value={name} onChange={(e) => setName(e.target.value)} maxLength={100} /></Field>
        <Field label="Price list"><select value={list || eligible[0]?.id || ''} onChange={(e) => setList(e.target.value)}>{eligible.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>
        <Field label="Cashier discount limit (%)" hint="Larger discounts need a supervisor"><input inputMode="decimal" value={disc} onChange={(e) => setDisc(e.target.value)} /></Field>
        <Field label="Refund approval threshold" hint="Refunds above this amount need approval. Leave empty for no limit."><input inputMode="decimal" value={refund} onChange={(e) => setRefund(e.target.value)} /></Field>
        <div className="form-actions"><button className="btn btn-primary" disabled={c.busy || !code || !name || !eligible.length}>Add register</button></div>
      </form><Result c={c} />
    </details>
  );
}
