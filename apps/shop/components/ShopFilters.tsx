'use client';

import Link from 'next/link';
import { plural, useI18n } from '@/lib/i18n';
import type { I18n } from '@/lib/types';

interface Dept { slug: string; name: string; productCount: number; i18n?: I18n }

const SORTS = ['featured', 'newest', 'price_asc', 'price_desc'] as const;

/** The shop listing's filter sidebar, sort bar and pager. The server decides what is shown; this only words it. */
export function ShopFilters({ departments, currency, query, hrefs }: {
  departments: Dept[]; currency: string;
  query: { department: string; q: string; sort: string; minPrice: string; maxPrice: string; inStock: boolean };
  /** Pre-built links, because the server owns the address rules. */
  hrefs: { department: Record<string, string>; allDepartments: string; sort: Record<string, string> };
}) {
  const { t, c } = useI18n();
  return (
    <>
      <aside className="filters" aria-label={t('shop.filters')}>
        <fieldset>
          <legend>{t('shop.department')}</legend>
          <ul>
            <li><Link href={hrefs.allDepartments} aria-current={!query.department}>{t('shop.all')}</Link></li>
            {departments.map((d) => (
              <li key={d.slug}><Link href={hrefs.department[d.slug]!} aria-current={query.department === d.slug}>{c(d, 'name', d.name)} ({d.productCount})</Link></li>
            ))}
          </ul>
        </fieldset>
        <form action="/shop" method="get">
          {query.department && <input type="hidden" name="department" value={query.department} />}
          {query.sort && <input type="hidden" name="sort" value={query.sort} />}
          <fieldset>
            <legend>{t('shop.search')}</legend>
            <input name="q" type="search" defaultValue={query.q} aria-label={t('shop.search')} />
          </fieldset>
          <fieldset>
            <legend>{t('shop.price', { currency })}</legend>
            <div className="grid2">
              <input name="minPrice" inputMode="decimal" placeholder={t('shop.min')} defaultValue={query.minPrice} aria-label={t('shop.minLabel')} />
              <input name="maxPrice" inputMode="decimal" placeholder={t('shop.max')} defaultValue={query.maxPrice} aria-label={t('shop.maxLabel')} />
            </div>
          </fieldset>
          <label className="row"><input type="checkbox" name="inStock" value="true" defaultChecked={query.inStock} style={{ width: 'auto', minHeight: 0 }} /> {t('shop.inStockOnly')}</label>
          <button className="btn small" type="submit" style={{ marginTop: 12 }}>{t('shop.apply')}</button>
        </form>
      </aside>
    </>
  );
}

export function ListingBar({ total, sort, sortHrefs }: { total: number | null; sort: string; sortHrefs: Record<string, string> }) {
  const { t } = useI18n();
  const current = sort || 'featured';
  return (
    <div className="row spread" style={{ marginBottom: 16 }}>
      <span className="muted" aria-live="polite">{total === null ? '' : t(plural('shop.count', total), { n: total })}</span>
      <nav className="row" aria-label={t('shop.sort')}>
        {SORTS.map((v) => (
          <Link key={v} href={sortHrefs[v]!} aria-current={current === v} className="small" style={{ fontWeight: current === v ? 700 : 400 }}>{t(`shop.sort.${v}`)}</Link>
        ))}
      </nav>
    </div>
  );
}

export function EmptyListing() {
  const { t } = useI18n();
  return <div className="empty"><h2>{t('shop.nothing')}</h2><p className="muted">{t('shop.tryFewer')}</p><Link className="btn" href="/shop">{t('shop.clear')}</Link></div>;
}

export function Pager({ page, pages, prev, next }: { page: number; pages: number; prev: string | null; next: string | null }) {
  const { t } = useI18n();
  return (
    <nav className="pager" aria-label={t('shop.pages')}>
      {prev && <Link className="btn ghost small" href={prev}>{t('shop.prev')}</Link>}
      <span className="muted">{t('shop.pageOf', { page, pages })}</span>
      {next && <Link className="btn ghost small" href={next}>{t('shop.next')}</Link>}
    </nav>
  );
}

export function ListingTitle({ q, department }: { q: string; department: Dept | null }) {
  const { t, c } = useI18n();
  return <h1>{q ? t('shop.resultsFor', { q }) : department ? c(department, 'name', department.name) : t('shop.allFabrics')}</h1>;
}
