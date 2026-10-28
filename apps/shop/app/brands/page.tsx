import type { Metadata } from 'next';
import Link from 'next/link';
import { T } from '@/lib/i18n';

export const metadata: Metadata = { title: 'Our brands' };

const BRANDS = ['Empire Atampa', 'Super Conclusive', 'Florance', 'Flora', 'Ismile', 'Egyptian Kamfala', 'Mudatex Java', 'Super Xperia'];

export default function Brands() {
  return (
    <div className="wrap section">
      <div className="prose"><h1><T k="brands.title" /></h1><p><T k="brands.text" /></p></div>
      <div className="tiles">
        {BRANDS.map((b) => <Link key={b} className="tile" href={`/shop?q=${encodeURIComponent(b)}`}><span>{b}</span></Link>)}
      </div>
    </div>
  );
}
