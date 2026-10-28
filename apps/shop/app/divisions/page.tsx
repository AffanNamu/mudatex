import type { Metadata } from 'next';
import Link from 'next/link';
import { T } from '@/lib/i18n';

export const metadata: Metadata = { title: 'What we do' };

export default function Divisions() {
  return (
    <div className="wrap section prose">
      <h1><T k="divisions.title" /></h1>
      <h2><T k="divisions.textiles" /></h2>
      <p><T k="divisions.textilesText" /> <Link href="/shop"><T k="divisions.shopOnline" /></Link> <T k="divisions.or" /> <Link href="/wholesale"><T k="divisions.wholesaleDesk" /></Link>.</p>
      <h2><T k="divisions.manufacturing" /></h2>
      <p><T k="divisions.manufacturingText" /></p>
      <h2><T k="divisions.furniture" /></h2>
      <p><T k="divisions.furnitureText" /></p>
      <h2><T k="divisions.realEstate" /></h2>
      <p><T k="divisions.realEstateText" /></p>
      <p className="small muted"><T k="divisions.tbc" /></p>
    </div>
  );
}
