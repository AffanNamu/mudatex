import Link from 'next/link';
import { ProductCard } from '@/components/ProductCard';
import { getStore } from '@/lib/api';
import { T } from '@/lib/i18n';

export const revalidate = 60;

export default async function Home() {
  const store = await getStore();
  if (!store) return null; // the layout explains that the shop is closed
  return (
    <>
      <section className="hero">
        <div className="wrap">
          <div>
            <h1><T k="home.title" /></h1>
            <p><T k="home.lead" /></p>
            <div className="row">
              <Link className="btn" href="/shop"><T k="home.shopCollection" /></Link>
              <Link className="btn ghost" href="/wholesale"><T k="home.buyWholesale" /></Link>
            </div>
          </div>
          <div className="hero-art" aria-hidden="true" />
        </div>
      </section>

      <div className="wrap trust" role="list">
        <div role="listitem"><strong><T k="home.trust1" /></strong><span className="muted small"><T k="home.trust1b" /></span></div>
        <div role="listitem"><strong><T k="home.trust2" /></strong><span className="muted small"><T k="home.trust2b" /></span></div>
        <div role="listitem"><strong><T k="home.trust3" /></strong><span className="muted small"><T k="home.trust3b" /></span></div>
        <div role="listitem"><strong><T k="home.trust4" /></strong><span className="muted small"><T k="home.trust4b" /></span></div>
      </div>

      {store.departments.length > 0 && (
        <section className="section wrap" aria-labelledby="depts">
          <h2 id="depts"><T k="home.byDepartment" /></h2>
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
        <div className="row spread"><h2 id="feat"><T k="home.featured" /></h2><Link href="/shop"><T k="home.seeEverything" /></Link></div>
        <div className="products">
          {store.featured.map((p) => <ProductCard key={p.id} p={p} store={store} />)}
        </div>
      </section>
    </>
  );
}
