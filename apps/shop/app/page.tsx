import Link from 'next/link';
import { ProductCard } from '@/components/ProductCard';
import { getStore } from '@/lib/api';

export const revalidate = 60;

export default async function Home() {
  const store = await getStore();
  if (!store) return null; // the layout explains that the shop is closed
  return (
    <>
      <section className="hero">
        <div className="wrap">
          <div>
            <h1>Fabrics with the finest finish, straight from the source.</h1>
            <p>Lace, Ankara, brocade, atampa and more — sold by the metre or the roll, priced honestly, and delivered to your door.</p>
            <div className="row">
              <Link className="btn" href="/shop">Shop the collection</Link>
              <Link className="btn ghost" href="/wholesale">Buy wholesale</Link>
            </div>
          </div>
          <div className="hero-art" aria-hidden="true" />
        </div>
      </section>

      <div className="wrap trust" role="list">
        <div role="listitem"><strong>Sold by the metre</strong><span className="muted small">Cut to the length you need</span></div>
        <div role="listitem"><strong>Real stock</strong><span className="muted small">What you see is what we hold</span></div>
        <div role="listitem"><strong>Delivery nationwide</strong><span className="muted small">Clear fees before you pay</span></div>
        <div role="listitem"><strong>Made by Mudassir &amp; Brothers</strong><span className="muted small">Trading since 1997</span></div>
      </div>

      {store.departments.length > 0 && (
        <section className="section wrap" aria-labelledby="depts">
          <h2 id="depts">Shop by department</h2>
          <div className="tiles">
            {store.departments.map((d) => (
              <Link className="tile" key={d.slug} href={`/shop?department=${d.slug}`}>
                {d.imageUrl && <img src={d.imageUrl} alt="" loading="lazy" />}
                <span>{d.name}</span>
              </Link>
            ))}
          </div>
        </section>
      )}

      <section className="section wrap" aria-labelledby="feat">
        <div className="row spread"><h2 id="feat">Featured fabrics</h2><Link href="/shop">See everything →</Link></div>
        <div className="products">
          {store.featured.map((p) => <ProductCard key={p.id} p={p} store={store} />)}
        </div>
      </section>
    </>
  );
}
