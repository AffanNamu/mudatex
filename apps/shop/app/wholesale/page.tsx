import type { Metadata } from 'next';
import Link from 'next/link';
import { EnquiryForm } from '@/components/EnquiryForm';
import { T } from '@/lib/i18n';

export const metadata: Metadata = { title: 'Wholesale' };

export default function Wholesale() {
  return (
    <div className="wrap section">
      <div className="prose">
        <h1><T k="wholesale.title" /></h1>
        <p><Link className="btn" href="/trade"><T k="wholesale.apply" /></Link></p>
        <p><T k="wholesale.text" /></p>
      </div>
      <div style={{ maxWidth: 640 }}>
        <EnquiryForm kind="wholesale" showCompany messageLabel="wholesale.message" placeholder="wholesale.placeholder" cta="wholesale.cta" />
        <p className="small muted"><T k="wholesale.note" /></p>
      </div>
    </div>
  );
}
