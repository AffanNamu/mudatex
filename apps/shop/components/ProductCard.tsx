import Link from 'next/link';
import { formatMoney } from '@/lib/format';
import type { ProductCard as Card, Store } from '@/lib/types';
import { WishlistButton } from './WishlistButton';

export function ProductCard({ p, store }: { p: Card; store: Store }) {
  return (
    <article className="pcard">
      <div className="chips">
        {!p.inStock && <span className="chip out">Sold out</span>}
        {p.badges.map((b) => <span className="chip" key={b}>{b}</span>)}
      </div>
      <WishlistButton slug={p.slug} className="iconbtn wish" />
      <div className="img">
        {p.images[0] ? <img src={p.images[0]} alt="" loading="lazy" /> : <div className="placeholder" aria-hidden="true">{p.title.slice(0, 1)}</div>}
      </div>
      <div className="body">
        {p.brand && <div className="small muted">{p.brand}</div>}
        <Link className="title" href={`/product/${p.slug}`}>{p.title}</Link>
        <div className="price">{formatMoney(p.priceMinor, p.currency, store.minorUnit)}</div>
      </div>
    </article>
  );
}
