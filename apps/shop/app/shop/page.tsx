import type { Metadata } from 'next';
import Link from 'next/link';
import { ProductCard } from '@/components/ProductCard';
import { getProducts, getStore } from '@/lib/api';

export const metadata: Metadata = { title: 'Shop all fabrics' };

type SP = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

const SORTS = [
  ['featured', 'Featured'], ['newest', 'Newest'], ['price_asc', 'Price: low to high'], ['price_desc', 'Price: high to low'],
] as const;

export default async function Shop({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const store = await getStore();
  if (!store) return null;
  const q = new URLSearchParams();
  for (const k of ['department', 'q', 'sort', 'minPrice', 'maxPrice', 'inStock', 'page']) {
    const v = one(sp[k]);
    if (v) q.set(k, v);
  }
  const data = await getProducts(q);
  const page = Number(q.get('page') ?? 1);
  const pages = data ? Math.ceil(data.total / data.limit) : 0;
  const href = (patch: Record<string, string | null>) => {
    const n = new URLSearchParams(q);
    for (const [k, v] of Object.entries(patch)) { if (v === null) n.delete(k); else n.set(k, v); }
    if (!('page' in patch)) n.delete('page');
    const s = n.toString();
    return s ? `/shop?${s}` : '/shop';
  };
  const current = store.departments.find((d) => d.slug === q.get('department'));

  return (
    <div className="wrap section">
      <h1>{q.get('q') ? `Results for “${q.get('q')}”` : current?.name ?? 'All fabrics'}</h1>
      <div className="listing">
        <aside className="filters" aria-label="Filters">
          <fieldset>
            <legend>Department</legend>
            <ul>
              <li><Link href={href({ department: null })} aria-current={!q.get('department')}>All</Link></li>
              {store.departments.map((d) => (
                <li key={d.slug}><Link href={href({ department: d.slug })} aria-current={q.get('department') === d.slug}>{d.name} ({d.productCount})</Link></li>
              ))}
            </ul>
          </fieldset>
          <form action="/shop" method="get">
            {q.get('department') && <input type="hidden" name="department" value={q.get('department')!} />}
            {q.get('sort') && <input type="hidden" name="sort" value={q.get('sort')!} />}
            <fieldset>
              <legend>Search</legend>
              <input name="q" type="search" defaultValue={q.get('q') ?? ''} aria-label="Search" />
            </fieldset>
            <fieldset>
              <legend>Price ({store.currency})</legend>
              <div className="grid2">
                <input name="minPrice" inputMode="decimal" placeholder="Min" defaultValue={q.get('minPrice') ?? ''} aria-label="Minimum price" />
                <input name="maxPrice" inputMode="decimal" placeholder="Max" defaultValue={q.get('maxPrice') ?? ''} aria-label="Maximum price" />
              </div>
            </fieldset>
            <label className="row"><input type="checkbox" name="inStock" value="true" defaultChecked={q.get('inStock') === 'true'} style={{ width: 'auto', minHeight: 0 }} /> In stock only</label>
            <button className="btn small" type="submit" style={{ marginTop: 12 }}>Apply</button>
          </form>
        </aside>

        <div>
          <div className="row spread" style={{ marginBottom: 16 }}>
            <span className="muted" aria-live="polite">{data ? `${data.total} ${data.total === 1 ? 'product' : 'products'}` : ''}</span>
            <nav className="row" aria-label="Sort">
              {SORTS.map(([v, label]) => (
                <Link key={v} href={href({ sort: v })} aria-current={(q.get('sort') ?? 'featured') === v} className="small" style={{ fontWeight: (q.get('sort') ?? 'featured') === v ? 700 : 400 }}>{label}</Link>
              ))}
            </nav>
          </div>
          {!data || data.items.length === 0 ? (
            <div className="empty"><h2>Nothing matches yet</h2><p className="muted">Try fewer filters or a different word.</p><Link className="btn" href="/shop">Clear filters</Link></div>
          ) : (
            <div className="products">{data.items.map((p) => <ProductCard key={p.id} p={p} store={store} />)}</div>
          )}
          {pages > 1 && (
            <nav className="pager" aria-label="Pages">
              {page > 1 && <Link className="btn ghost small" href={href({ page: String(page - 1) })}>← Previous</Link>}
              <span className="muted">Page {page} of {pages}</span>
              {page < pages && <Link className="btn ghost small" href={href({ page: String(page + 1) })}>Next →</Link>}
            </nav>
          )}
        </div>
      </div>
    </div>
  );
}
