import type { Metadata } from 'next';
import Link from 'next/link';
import { T } from '@/lib/i18n';

export const metadata: Metadata = { title: 'Our story' };

export default function About() {
  return (
    <div className="wrap section prose">
      <h1><T k="about.title" /></h1>
      <p><T k="about.p1" /></p>
      <h2><T k="about.stand" /></h2>
      <ul>
        <li><strong><T k="about.honestStock" /></strong> <T k="about.honestStockText" /></li>
        <li><strong><T k="about.honestPrices" /></strong> <T k="about.honestPricesText" /></li>
        <li><strong><T k="about.cut" /></strong> <T k="about.cutText" /></li>
      </ul>
      <p><Link className="btn" href="/shop"><T k="home.shopCollection" /></Link> <Link className="btn ghost" href="/divisions"><T k="footer.whatWeDo" /></Link> <Link className="btn ghost" href="/brands"><T k="footer.brands" /></Link></p>
    </div>
  );
}
