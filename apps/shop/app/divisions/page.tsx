import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = { title: 'What we do' };

export default function Divisions() {
  return (
    <div className="wrap section prose">
      <h1>What we do</h1>
      <h2>Textiles</h2>
      <p>We import and sell fine fabrics — lace, Ankara, brocade, atampa and more — to shoppers and to traders, by the metre, the roll or the bale. <Link href="/shop">Shop online</Link> or <Link href="/wholesale">talk to our wholesale desk</Link>.</p>
      <h2>Manufacturing</h2>
      <p>Since 2005 we have made our own fabrics, which is why our own brands are available at honest prices and in depth.</p>
      <h2>Furniture</h2>
      <p>Our furniture business followed in 2007, supplying homes and businesses.</p>
      <h2>Real estate and markets</h2>
      <p>We own and run shopping malls and market space in Kano, Kaduna, Katsina, Sokoto, Gombe and other cities, where traders and shoppers come together.</p>
      <p className="small muted">Facts on this page are drawn from public information and are to be confirmed by the company before launch.</p>
    </div>
  );
}
