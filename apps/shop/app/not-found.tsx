import Link from 'next/link';
import { T } from '@/lib/i18n';

export default function NotFound() {
  return (
    <div className="wrap empty">
      <h1><T k="notfound.title" /></h1>
      <p className="muted"><T k="notfound.text" /></p>
      <Link className="btn" href="/shop"><T k="notfound.cta" /></Link>
    </div>
  );
}
