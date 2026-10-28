import type { Metadata } from 'next';
import { EnquiryForm } from '@/components/EnquiryForm';
import { T } from '@/lib/i18n';

export const metadata: Metadata = { title: 'Made to order' };

export default function CustomOrders() {
  return (
    <div className="wrap section">
      <div className="prose">
        <h1><T k="custom.title" /></h1>
        <p><T k="custom.text" /></p>
      </div>
      <div style={{ maxWidth: 640 }}>
        <EnquiryForm kind="custom_order" messageLabel="custom.message" placeholder="custom.placeholder" cta="custom.cta" />
      </div>
    </div>
  );
}
