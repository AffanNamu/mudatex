import type { Metadata } from 'next';
import { ProductCard } from '@/components/ProductCard';
import { EmptyListing, ListingBar, ListingTitle, Pager, ShopFilters } from '@/components/ShopFilters';
import { getProducts, getStore } from '@/lib/api';

export const metadata: Metadata = { title: 'Shop all fabrics' };

type SP = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

const SORTS = ['featured', 'newest', 'price_asc', 'price_desc'] as const;

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
      <ListingTitle q={q.get('q') ?? ''} department={current ?? null} />
      <div className="listing">
        <ShopFilters
          departments={store.departments}
          currency={store.currency}
          query={{ department: q.get('department') ?? '', q: q.get('q') ?? '', sort: q.get('sort') ?? '', minPrice: q.get('minPrice') ?? '', maxPrice: q.get('maxPrice') ?? '', inStock: q.get('inStock') === 'true' }}
          hrefs={{
            allDepartments: href({ department: null }),
            department: Object.fromEntries(store.departments.map((d) => [d.slug, href({ department: d.slug })])),
            sort: Object.fromEntries(SORTS.map((v) => [v, href({ sort: v })])),
          }}
        />
        <div>
          <ListingBar total={data ? data.total : null} sort={q.get('sort') ?? ''} sortHrefs={Object.fromEntries(SORTS.map((v) => [v, href({ sort: v })]))} />
          {!data || data.items.length === 0 ? (
            <EmptyListing />
          ) : (
            <div className="products">{data.items.map((p) => <ProductCard key={p.id} p={p} store={store} />)}</div>
          )}
          {pages > 1 && <Pager page={page} pages={pages} prev={page > 1 ? href({ page: String(page - 1) }) : null} next={page < pages ? href({ page: String(page + 1) }) : null} />}
        </div>
      </div>
    </div>
  );
}
