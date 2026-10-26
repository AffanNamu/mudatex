import type { MetadataRoute } from 'next';
import { getProducts, getStore } from '@/lib/api';
import { SITE_URL } from '@/lib/config';

export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const store = await getStore();
  const pages = ['', '/shop', '/about', '/contact', '/delivery', '/wholesale'].map((p) => ({ url: `${SITE_URL}${p}` }));
  if (!store) return pages;
  const products: MetadataRoute.Sitemap = [];
  for (let page = 1; page <= 20; page++) {
    const data = await getProducts(new URLSearchParams({ page: String(page), limit: '60' }));
    if (!data) break;
    products.push(...data.items.map((p) => ({ url: `${SITE_URL}/product/${p.slug}` })));
    if (page * data.limit >= data.total) break;
  }
  return [...pages, ...store.departments.map((d) => ({ url: `${SITE_URL}/shop?department=${d.slug}` })), ...products];
}
