import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = { title: 'Our story' };

export default function About() {
  return (
    <div className="wrap section prose">
      <h1>Our story</h1>
      <p>Mudassir &amp; Brothers began in 1997 in Kano, importing fine fabrics for the markets of northern Nigeria. In 2005 we began making our own textiles, and today our brands — Empire Atampa, Super Conclusive, Florance, Flora, Ismile, Egyptian Kamfala, Mudatex Java and Super Xperia — are worn from Kwari Market to weddings across West Africa.</p>
      <h2>What we stand for</h2>
      <ul>
        <li><strong>Honest stock.</strong> Every fabric you see here is counted in our warehouses. If it&apos;s on the site, we have it.</li>
        <li><strong>Honest prices.</strong> The price you see is the price you pay, tax included, with delivery shown before you commit.</li>
        <li><strong>Cut to your need.</strong> Buy a metre, a yard or a full roll.</li>
      </ul>
      <p><Link className="btn" href="/shop">Shop the collection</Link></p>
    </div>
  );
}
