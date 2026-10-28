import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ProductView } from '@/components/ProductView';
import { ReviewForm } from '@/components/ReviewForm';
import { Stars } from '@/components/Stars';
import { getProduct, getReviews, getStore } from '@/lib/api';
import { SITE_URL } from '@/lib/config';
import { T } from '@/lib/i18n';

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
  const reviews = await getReviews(p.slug);
  const lowest = Math.min(...p.variants.map((v) => v.priceMinor));
  const ld = {
    '@context': 'https://schema.org', '@type': 'Product', name: p.title, description: p.description ?? undefined, image: p.images,
    brand: p.brand ? { '@type': 'Brand', name: p.brand } : undefined,
    aggregateRating: p.rating.count ? { '@type': 'AggregateRating', ratingValue: p.rating.average, reviewCount: p.rating.count } : undefined,
    offers: { '@type': 'Offer', priceCurrency: p.currency, price: (lowest / 10 ** store.minorUnit).toFixed(store.minorUnit), availability: p.variants.some((v) => v.inStock) ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock' },
  };
  return (
    <div className="wrap section">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(ld).replace(/</g, '\\u003c') }} />
      <ProductView p={p} />
      <section className="section" aria-labelledby="reviews">
        <h2 id="reviews"><T k="reviews.title" /> {p.rating.count > 0 && <span className="muted small"><Stars value={p.rating.average ?? 0} /> <T k={p.rating.count === 1 ? 'reviews.summary.one' : 'reviews.summary.other'} vars={{ avg: p.rating.average ?? 0, n: p.rating.count }} /></span>}</h2>
        {reviews && reviews.items.length > 0 ? (
          <ul className="plain" style={{ listStyle: 'none', padding: 0 }}>
            {reviews.items.map((r, i) => (
              <li key={i} className="card" style={{ marginBottom: 12 }}>
                <Stars value={r.rating} /> {r.title && <strong>{r.title}</strong>}
                <p style={{ margin: '6px 0' }}>{r.body}</p>
                <span className="small muted">{r.name} · {new Date(r.at).toLocaleDateString()} · <T k="reviews.verified" /></span>
              </li>
            ))}
          </ul>
        ) : <p className="muted"><T k="reviews.none" /></p>}
        <ReviewForm productSlug={p.slug} />
      </section>
    </div>
  );
}
