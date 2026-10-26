import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = { title: 'Our brands' };

const BRANDS = ['Empire Atampa', 'Super Conclusive', 'Florance', 'Flora', 'Ismile', 'Egyptian Kamfala', 'Mudatex Java', 'Super Xperia'];

export default function Brands() {
  return (
    <div className="wrap section">
      <div className="prose"><h1>Our brands</h1><p>Mudassir &amp; Brothers makes and sells fabrics under these names. Choose a brand to see what we have in stock.</p></div>
      <div className="tiles">
        {BRANDS.map((b) => <Link key={b} className="tile" href={`/shop?q=${encodeURIComponent(b)}`}><span>{b}</span></Link>)}
      </div>
    </div>
  );
}
