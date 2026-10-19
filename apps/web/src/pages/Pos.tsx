import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ErrorBanner, Field, Loading, Notice, PageHeader } from '../components/ui';
import { api, newKey } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useDebounced, useLoad } from '../lib/hooks';
import { formatMoney, parseMoney, parseQuantity } from '../lib/money';
import type { PendingRow } from './Payments';

interface Register {
  id: string; code: string; name: string; status: string; currency: string; minorUnit: number; maxDiscountBps: number;
  openSessionId: string | null; openSessionCashierId: string | null;
}
interface CatalogItem { variantId: string; sku: string; name: string; unit: string; unitPrice: string; available: string }
interface CartLine { variantId: string; sku: string; name: string; unit: string; quantity: string; discountPercent: string }
interface QuoteLine { variantId: string; sku: string; quantity: string; unitPrice: string; totalMinor: number; discountMinor: number; insufficientStock: boolean; available: string }
interface Quote { currency: string; minorUnit: number; lines: QuoteLine[]; subtotalMinor: number; discountMinor: number; taxMinor: number; totalMinor: number; sellable: boolean }
interface Sale {
  id: string; receiptNumber: string; status: string; currency: string; minorUnit: number; totalMinor: number; subtotalMinor: number; discountMinor: number; taxMinor: number; completedAt: string | null;
  lines: { lineNo: number; variantId: string; quantity: string; unitPrice: string; totalMinor: number }[];
  payments: { id: string; method: string; amountMinor: number; tenderedMinor: number | null; changeMinor: number | null; reference: string | null; status: string }[];
}
interface SessionReport { sessionId: string; openingFloatMinor: number; salesByMethod: { method: string; totalMinor: number; sales: number }[]; pendingSales: number; expectedCashMinor: number }

const METHODS = [['cash', 'Cash'], ['card', 'Card'], ['bank_transfer', 'Bank transfer'], ['mobile_money', 'Mobile money']] as const;

/** Basis points from a typed percentage such as "12.5" (= 1250). Null when it is not a valid 0–100 value with ≤2 decimals. */
export function percentToBps(text: string): number | null {
  const t = text.trim();
  if (t === '') return 0;
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const [w = '0', f = ''] = t.split('.');
  const bps = Number(w) * 100 + Number(f.padEnd(2, '0'));
  return bps <= 10000 ? bps : null;
}

const toLines = (cart: CartLine[]) => cart.map((l) => {
  const bps = percentToBps(l.discountPercent);
  return { variantId: l.variantId, quantity: l.quantity, ...(bps ? { discount: { type: 'percent' as const, basisPoints: bps } } : {}) };
});

export function Pos() {
  const registers = useLoad<Register[]>('/v1/pos/registers');
  const [registerId, setRegisterId] = useState('');
  const usable = useMemo(() => (registers.data ?? []).filter((r) => r.status === 'active'), [registers.data]);
  const register = usable.find((r) => r.id === registerId) ?? usable[0];

  return (
    <>
      <PageHeader title="Point of sale">
        {usable.length > 1 && (
          <label className="field inline"><span className="field-label">Register</span>
            <select value={register?.id ?? ''} onChange={(e) => setRegisterId(e.target.value)}>
              {usable.map((r) => <option key={r.id} value={r.id}>{r.code} — {r.name}</option>)}
            </select>
          </label>
        )}
      </PageHeader>
      <ErrorBanner error={registers.error} />
      {registers.loading && <Loading what="registers" />}
      {!registers.loading && !register && <Notice>No active register is available to you.</Notice>}
      {register && <Terminal key={register.id} register={register} reloadRegisters={registers.reload} />}
    </>
  );
}

function Terminal({ register, reloadRegisters }: { register: Register; reloadRegisters(): void }) {
  const { session } = useAuth();
  const mine = register.openSessionCashierId === session?.user.id;
  if (!register.openSessionId) return <OpenSession register={register} onOpened={reloadRegisters} />;
  if (!mine) return <Notice tone="warn">This register is in use by another cashier. Choose another register or ask them to close their session.</Notice>;
  return <Till register={register} sessionId={register.openSessionId} onClosed={reloadRegisters} />;
}

function OpenSession({ register, onOpened }: { register: Register; onOpened(): void }) {
  const [floatText, setFloatText] = useState('0');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const key = useRef(newKey());
  const minor = parseMoney(floatText, register.minorUnit);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (minor === null) return;
    setBusy(true); setError(null);
    try {
      await api(`/v1/pos/registers/${register.id}/sessions`, { method: 'POST', body: { openingFloatMinor: minor }, idempotencyKey: key.current });
      onOpened();
    } catch (err) { setError(err); setBusy(false); }
  }
  return (
    <form className="card" onSubmit={submit}>
      <h2>Open {register.code}</h2>
      <p className="muted">Count the cash in the drawer and enter it as the opening float.</p>
      <ErrorBanner error={error} />
      <Field label={`Opening float (${register.currency})`} error={minor === null ? 'Enter an amount such as 100.00' : null}>
        <input inputMode="decimal" value={floatText} onChange={(e) => { setFloatText(e.target.value); key.current = newKey(); }} />
      </Field>
      <button className="btn btn-primary" disabled={busy || minor === null}>Open session</button>
    </form>
  );
}

function Till({ register, sessionId, onClosed }: { register: Register; sessionId: string; onClosed(): void }) {
  const fmt = (m: number) => formatMoney(m, register.currency, register.minorUnit);
  const [search, setSearch] = useState('');
  const dq = useDebounced(search, 200);
  const catalog = useLoad<CatalogItem[]>(`/v1/pos/registers/${register.id}/catalog?limit=30${dq ? `&q=${encodeURIComponent(dq)}` : ''}`);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteError, setQuoteError] = useState<unknown>(null);
  const [receipt, setReceipt] = useState<Sale | null>(null);
  const [closing, setClosing] = useState(false);

  const lines = useMemo(() => {
    if (cart.some((l) => !parseQuantity(l.quantity) || percentToBps(l.discountPercent) === null)) return null;
    return toLines(cart);
  }, [cart]);
  const quoteBody = useDebounced(lines && lines.length ? JSON.stringify(lines) : null, 250);

  useEffect(() => {
    if (!quoteBody) { setQuote(null); setQuoteError(null); return; }
    const ac = new AbortController();
    api<Quote>(`/v1/pos/registers/${register.id}/quote`, { method: 'POST', body: { lines: JSON.parse(quoteBody) }, signal: ac.signal })
      .then((q) => { setQuote(q); setQuoteError(null); })
      .catch((e) => { if (e.name !== 'AbortError') { setQuote(null); setQuoteError(e); } });
    return () => ac.abort();
  }, [quoteBody, register.id]);

  function add(item: CatalogItem) {
    setCart((c) => {
      const i = c.findIndex((l) => l.variantId === item.variantId);
      if (i >= 0) return c.map((l, j) => (j === i ? { ...l, quantity: String(Number(l.quantity) + 1) } : l));
      return [...c, { variantId: item.variantId, sku: item.sku, name: item.name, unit: item.unit, quantity: '1', discountPercent: '' }];
    });
  }
  const change = (i: number, patch: Partial<CartLine>) => setCart((c) => c.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  function scan(e: FormEvent) {
    e.preventDefault();
    // A barcode scanner types the code and presses Enter: sell the first match.
    const first = catalog.data?.[0];
    if (first && dq === search) { add(first); setSearch(''); }
  }

  if (closing) return <CloseSession register={register} sessionId={sessionId} onCancel={() => setClosing(false)} onClosed={onClosed} />;

  if (receipt) return <Receipt sale={receipt} register={register} onNext={() => { setReceipt(null); setCart([]); setQuote(null); catalog.reload(); }} />;

  const quoted = new Map((quote?.lines ?? []).map((l) => [l.variantId, l]));
  return (
    <div className="pos-grid">
      <section aria-label="Products" className="card">
        <form onSubmit={scan}>
          <Field label="Search or scan">
            <input type="search" autoFocus value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name, SKU or barcode" />
          </Field>
        </form>
        <ErrorBanner error={catalog.error} />
        {catalog.loading && !catalog.data ? <Loading what="products" /> : (
          <ul className="catalog">
            {(catalog.data ?? []).map((p) => (
              <li key={p.variantId}>
                <button type="button" className="tile" onClick={() => add(p)} disabled={Number(p.available) <= 0}>
                  <span className="tile-name">{p.name}</span>
                  <span className="muted">{p.sku}</span>
                  <span>{p.unitPrice} / {p.unit}</span>
                  <span className={Number(p.available) <= 0 ? 'bad' : 'muted'}>{Number(p.available) <= 0 ? 'Out of stock' : `${p.available} ${p.unit} available`}</span>
                </button>
              </li>
            ))}
            {catalog.data?.length === 0 && <li className="muted">No products match.</li>}
          </ul>
        )}
      </section>

      <section aria-label="Cart" className="card">
        <h2>Cart</h2>
        {cart.length === 0 ? <p className="muted">Add products to start a sale.</p> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th scope="col">Item</th><th scope="col">Qty</th><th scope="col">Disc. %</th><th scope="col" className="num">Total</th><th scope="col"><span className="sr-only">Remove</span></th></tr></thead>
              <tbody>
                {cart.map((l, i) => {
                  const q = quoted.get(l.variantId);
                  const badQty = !parseQuantity(l.quantity);
                  const badDisc = percentToBps(l.discountPercent) === null;
                  return (
                    <tr key={l.variantId}>
                      <th scope="row">{l.name}<br /><span className="muted">{l.sku}</span>{q?.insufficientStock && <><br /><span className="bad">Only {q.available} {l.unit} available</span></>}</th>
                      <td><input className="narrow" aria-label={`Quantity of ${l.name}`} inputMode="decimal" aria-invalid={badQty} value={l.quantity} onChange={(e) => change(i, { quantity: e.target.value })} /></td>
                      <td><input className="narrow" aria-label={`Discount percent for ${l.name}`} inputMode="decimal" aria-invalid={badDisc} value={l.discountPercent} onChange={(e) => change(i, { discountPercent: e.target.value })} placeholder="0" /></td>
                      <td className="num">{q ? fmt(q.totalMinor) : '…'}</td>
                      <td><button type="button" className="btn btn-ghost" aria-label={`Remove ${l.name}`} onClick={() => setCart((c) => c.filter((_, j) => j !== i))}>✕</button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <ErrorBanner error={quoteError} />
        {quote && (
          <dl className="totals">
            <div><dt>Subtotal</dt><dd>{fmt(quote.subtotalMinor)}</dd></div>
            {quote.discountMinor > 0 && <div><dt>Discount</dt><dd>-{fmt(quote.discountMinor)}</dd></div>}
            <div><dt>Tax</dt><dd>{fmt(quote.taxMinor)}</dd></div>
            <div className="grand"><dt>Total</dt><dd data-testid="total">{fmt(quote.totalMinor)}</dd></div>
          </dl>
        )}
        {quote && cart.length > 0 && quote.sellable && lines && quoteBody === JSON.stringify(lines) && (
          <Payment key={quoteBody} register={register} quote={quote} lines={lines} onSold={setReceipt} />
        )}
        {quote && !quote.sellable && <Notice tone="warn">Resolve the stock shortages above to continue.</Notice>}
        <div className="row-end">
          <button type="button" className="btn btn-ghost" onClick={() => setClosing(true)}>Close session</button>
          {cart.length > 0 && <button type="button" className="btn btn-ghost" onClick={() => setCart([])}>Clear cart</button>}
        </div>
      </section>
    </div>
  );
}

function Payment({ register, quote, lines, onSold }: { register: Register; quote: Quote; lines: ReturnType<typeof toLines>; onSold(s: Sale): void }) {
  const fmt = (m: number) => formatMoney(m, register.currency, register.minorUnit);
  const [method, setMethod] = useState<(typeof METHODS)[number][0]>('cash');
  const [tendered, setTendered] = useState('');
  const [reference, setReference] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  // One intent, one key: it only changes when what is being sold changes (this component is re-keyed on the cart).
  const key = useRef(newKey());

  const cash = method === 'cash';
  const tenderedMinor = tendered.trim() === '' ? quote.totalMinor : parseMoney(tendered, register.minorUnit);
  const short = cash && (tenderedMinor === null || tenderedMinor < quote.totalMinor);
  const changeDue = cash && tenderedMinor !== null && tenderedMinor >= quote.totalMinor ? tenderedMinor - quote.totalMinor : 0;
  const missingRef = !cash && reference.trim() === '';

  async function pay() {
    setBusy(true); setError(null);
    try {
      const payment = cash
        ? { method, amountMinor: quote.totalMinor, tenderedMinor: tenderedMinor ?? quote.totalMinor }
        : { method, amountMinor: quote.totalMinor, reference: reference.trim() };
      const sale = await api<Sale>('/v1/pos/sales', {
        method: 'POST', idempotencyKey: key.current,
        body: { registerId: register.id, lines, payments: [payment], expectedTotalMinor: quote.totalMinor },
      });
      onSold(sale);
    } catch (e) {
      // Keep the cart and the key: a retry of the same intent after a dropped connection replays instead of double-charging.
      setError(e);
      setBusy(false);
    }
  }

  return (
    <fieldset className="payment">
      <legend>Payment</legend>
      <div role="radiogroup" aria-label="Payment method" className="methods">
        {METHODS.map(([v, label]) => (
          <label key={v} className={method === v ? 'chip chip-on' : 'chip'}>
            <input type="radio" name="method" value={v} checked={method === v} onChange={() => setMethod(v)} />{label}
          </label>
        ))}
      </div>
      {cash ? (
        <>
          <Field label={`Cash tendered (${register.currency})`} hint="Leave blank for the exact amount" error={tenderedMinor === null ? 'Enter an amount such as 50.00' : short ? 'Less than the total' : null}>
            <input inputMode="decimal" value={tendered} onChange={(e) => setTendered(e.target.value)} />
          </Field>
          {!short && changeDue > 0 && <p className="change" data-testid="change">Change due: <strong>{fmt(changeDue)}</strong></p>}
        </>
      ) : (
        <Field label="Provider reference" hint="The terminal or transfer reference. A supervisor confirms this payment before stock leaves.">
          <input value={reference} onChange={(e) => setReference(e.target.value)} />
        </Field>
      )}
      <ErrorBanner error={error} />
      <button type="button" className="btn btn-primary btn-lg" disabled={busy || short || missingRef} onClick={pay}>
        {busy ? 'Working…' : `Charge ${fmt(quote.totalMinor)}`}
      </button>
    </fieldset>
  );
}

function Receipt({ sale, register, onNext }: { sale: Sale; register: Register; onNext(): void }) {
  const fmt = (m: number) => formatMoney(m, sale.currency, sale.minorUnit);
  const pending = sale.status === 'pending_payment';
  return (
    <article className="card receipt" aria-label="Receipt">
      <h2>Receipt {sale.receiptNumber}</h2>
      {pending
        ? <Notice tone="warn">Awaiting payment confirmation. Stock is held but has not left the shop.</Notice>
        : <Notice tone="ok">Sale complete.</Notice>}
      <p className="muted">{register.code} · {sale.completedAt ? new Date(sale.completedAt).toLocaleString() : 'not yet completed'}</p>
      <table>
        <thead><tr><th scope="col">Qty</th><th scope="col">Price</th><th scope="col" className="num">Total</th></tr></thead>
        <tbody>{sale.lines.map((l) => <tr key={l.lineNo}><td>{l.quantity}</td><td>{l.unitPrice}</td><td className="num">{fmt(l.totalMinor)}</td></tr>)}</tbody>
      </table>
      <dl className="totals">
        <div><dt>Subtotal</dt><dd>{fmt(sale.subtotalMinor)}</dd></div>
        {sale.discountMinor > 0 && <div><dt>Discount</dt><dd>-{fmt(sale.discountMinor)}</dd></div>}
        <div><dt>Tax</dt><dd>{fmt(sale.taxMinor)}</dd></div>
        <div className="grand"><dt>Total</dt><dd>{fmt(sale.totalMinor)}</dd></div>
        {sale.payments.map((p) => (
          <div key={p.id}><dt>{p.method.replace('_', ' ')} ({p.status})</dt><dd>{fmt(p.tenderedMinor ?? p.amountMinor)}</dd></div>
        ))}
        {sale.payments.some((p) => p.changeMinor) && <div><dt>Change</dt><dd>{fmt(sale.payments.reduce((a, p) => a + (p.changeMinor ?? 0), 0))}</dd></div>}
      </dl>
      <div className="row-end">
        <button type="button" className="btn btn-ghost" onClick={() => window.print()}>Print</button>
        <button type="button" className="btn btn-primary" autoFocus onClick={onNext}>New sale</button>
      </div>
    </article>
  );
}

function CloseSession({ register, sessionId, onCancel, onClosed }: { register: Register; sessionId: string; onCancel(): void; onClosed(): void }) {
  const report = useLoad<SessionReport>(`/v1/pos/sessions/${sessionId}/report`);
  const pending = useLoad<PendingRow[]>(`/v1/pos/sales?sessionId=${sessionId}&status=pending_payment`);
  const fmt = (m: number) => formatMoney(m, register.currency, register.minorUnit);
  const [counted, setCounted] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ expectedCashMinor: number; countedCashMinor: number; varianceMinor: number } | null>(null);
  const key = useRef(newKey());
  const minor = parseMoney(counted, register.minorUnit);

  async function cancelSale(id: string) {
    setError(null);
    try {
      await api(`/v1/pos/sales/${id}/cancel`, { method: 'POST', idempotencyKey: newKey() });
      report.reload(); pending.reload();
    } catch (err) { setError(err); }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (minor === null) return;
    setBusy(true); setError(null);
    try {
      setResult(await api(`/v1/pos/sessions/${sessionId}/close`, { method: 'POST', body: { countedCashMinor: minor, note: note || undefined }, idempotencyKey: key.current }));
    } catch (err) { setError(err); setBusy(false); }
  }

  if (result) {
    return (
      <div className="card">
        <h2>Session closed</h2>
        <dl className="totals">
          <div><dt>Expected cash</dt><dd>{fmt(result.expectedCashMinor)}</dd></div>
          <div><dt>Counted</dt><dd>{fmt(result.countedCashMinor)}</dd></div>
          <div className="grand"><dt>Variance</dt><dd data-testid="variance">{fmt(result.varianceMinor)}</dd></div>
        </dl>
        <button type="button" className="btn btn-primary" onClick={onClosed}>Done</button>
      </div>
    );
  }
  return (
    <form className="card" onSubmit={submit}>
      <h2>Close {register.code}</h2>
      <ErrorBanner error={report.error} />
      {report.loading && <Loading what="session totals" />}
      {report.data && (
        <>
          <dl className="totals">
            <div><dt>Opening float</dt><dd>{fmt(report.data.openingFloatMinor)}</dd></div>
            {report.data.salesByMethod.map((s) => <div key={s.method}><dt>{s.method.replace('_', ' ')} ({s.sales} sales)</dt><dd>{fmt(s.totalMinor)}</dd></div>)}
          </dl>
          {report.data.pendingSales > 0 && (
            <>
              <Notice tone="warn">{report.data.pendingSales} sale(s) are still awaiting payment confirmation. A supervisor can confirm them, or you can cancel them here, before closing.</Notice>
              <ul className="plain">
                {(pending.data ?? []).map((s) => (
                  <li key={s.id} className="row-between">
                    <span>{s.receiptNumber} · {formatMoney(s.totalMinor, s.currency, register.minorUnit)}</span>
                    <button type="button" className="btn btn-ghost" onClick={() => cancelSale(s.id)} aria-label={`Cancel sale ${s.receiptNumber}`}>Cancel sale</button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
      <p className="muted">Count the cash in the drawer. The expected amount is shown after you close, so the count is honest.</p>
      <ErrorBanner error={error} />
      <Field label={`Counted cash (${register.currency})`} error={counted !== '' && minor === null ? 'Enter an amount such as 100.00' : null}>
        <input inputMode="decimal" value={counted} onChange={(e) => { setCounted(e.target.value); key.current = newKey(); }} />
      </Field>
      <Field label="Note (optional)"><input value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} /></Field>
      <div className="row-end">
        <button type="button" className="btn btn-ghost" onClick={onCancel}>Back to till</button>
        <button className="btn btn-primary" disabled={busy || minor === null}>Close session</button>
      </div>
    </form>
  );
}
