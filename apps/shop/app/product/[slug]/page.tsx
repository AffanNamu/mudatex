import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ProductView } from '@/components/ProductView';
import { getProduct, getStore } from '@/lib/api';
import { SITE_URL } from '@/lib/config';

export const revalidate = 60;
type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const p = await getProduct((await params).slug);
  if (!p) return { title: 'Not found' };
  return {
    title: p.title,
    description: (p.description ?? `${p.title} by the ${p.unit.name.toLowerCase()}.`).slice(0, 160),
    openGraph: { title: p.title, images: p.images.slice(0, 1) },
    alternates: { canonical: `${SITE_URL}/product/${p.slug}` },
  };
}

export default async function ProductPage({ params }: Props) {
  const p = await getProduct((await params).slug);
  if (!p) notFound();
  const store = await getStore();
  if (!store) notFound();
  const lowest = Math.min(...p.variants.map((v) => v.priceMinor));
  const ld = {
    '@context': 'https://schema.org', '@type': 'Product', name: p.title, description: p.description ?? undefined, image: p.images,
    brand: p.brand ? { '@type': 'Brand', name: p.brand } : undefined,
    offers: { '@type': 'Offer', priceCurrency: p.currency, price: (lowest / 10 ** store.minorUnit).toFixed(store.minorUnit), availability: p.variants.some((v) => v.inStock) ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock' },
  };
  return (
    <div className="wrap section">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(ld).replace(/</g, '\\u003c') }} />
      <ProductView p={p} />
    </div>
  );
}
