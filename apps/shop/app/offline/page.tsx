import Link from 'next/link';
import { T } from '@/lib/i18n';

export const metadata = { title: 'You are offline' };

export default function Offline() {
  return (
    <div className="wrap empty">
      <h1><T k="offline.title" /></h1>
      <p className="muted"><T k="offline.text" /></p>
      <Link className="btn" href="/"><T k="offline.cta" /></Link>
    </div>
  );
}
