import type { Metadata } from 'next';
import { T } from '@/lib/i18n';

export const metadata: Metadata = { title: 'Delivery & returns' };

export default function Delivery() {
  return (
    <div className="wrap section prose">
      <h1><T k="delivery.title" /></h1>
      <h2><T k="delivery.h1" /></h2>
      <p><T k="delivery.p1" /></p>
      <h2><T k="delivery.h2" /></h2>
      <p><T k="delivery.p2" /></p>
      <h2><T k="delivery.h3" /></h2>
      <p><T k="delivery.p3" /></p>
      <p className="small muted"><T k="delivery.tbc" /></p>
    </div>
  );
}
