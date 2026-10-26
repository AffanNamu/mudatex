import type { Metadata } from 'next';
import { EnquiryForm } from '@/components/EnquiryForm';

export const metadata: Metadata = { title: 'Made to order' };

export default function CustomOrders() {
  return (
    <div className="wrap section">
      <div className="prose">
        <h1>Made to order</h1>
        <p>Need a special colour, a design printed to your own pattern, or fabric cut and sewn for an event? Describe it and we will come back with what is possible, the price and the time it takes.</p>
      </div>
      <div style={{ maxWidth: 640 }}>
        <EnquiryForm kind="custom_order" messageLabel="Describe what you need" placeholder="Fabric, colour, quantity, and the date you need it by." cta="Ask for a quote" />
      </div>
    </div>
  );
}
