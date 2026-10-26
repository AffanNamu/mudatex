import type { Metadata } from 'next';
import { EnquiryForm } from '@/components/EnquiryForm';

export const metadata: Metadata = { title: 'Careers' };

export default function Careers() {
  return (
    <div className="wrap section">
      <div className="prose">
        <h1>Work with us</h1>
        <p>We hire in our shops, warehouses, mills and offices. Tell us about yourself and the kind of work you are looking for, and we will keep your details for the next opening.</p>
      </div>
      <div style={{ maxWidth: 640 }}>
        <EnquiryForm kind="careers" messageLabel="About you and the work you want" cta="Send my details" />
      </div>
    </div>
  );
}
