import type { Metadata } from 'next';
import { EnquiryForm } from '@/components/EnquiryForm';

export const metadata: Metadata = { title: 'Wholesale' };

export default function Wholesale() {
  return (
    <div className="wrap section">
      <div className="prose">
        <h1>Wholesale</h1>
        <p>Buying by the roll or the bale for your shop or market stall? Tell us what you buy and how often. We will send wholesale prices, arrange standing orders and quote delivery.</p>
      </div>
      <div style={{ maxWidth: 640 }}>
        <EnquiryForm kind="wholesale" showCompany messageLabel="What do you buy, and how much?" placeholder="For example: 200 rolls of Atampa a month, delivered to Kaduna." cta="Request wholesale prices" />
        <p className="small muted">Online trade accounts with credit terms and statements are being added.</p>
      </div>
    </div>
  );
}
