import type { Metadata } from 'next';
import { EnquiryForm } from '@/components/EnquiryForm';
import { T } from '@/lib/i18n';

export const metadata: Metadata = { title: 'Careers' };

export default function Careers() {
  return (
    <div className="wrap section">
      <div className="prose">
        <h1><T k="careers.title" /></h1>
        <p><T k="careers.text" /></p>
      </div>
      <div style={{ maxWidth: 640 }}>
        <EnquiryForm kind="careers" messageLabel="careers.message" cta="careers.cta" />
      </div>
    </div>
  );
}
