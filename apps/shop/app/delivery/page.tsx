import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Delivery & returns' };

export default function Delivery() {
  return (
    <div className="wrap section prose">
      <h1>Delivery &amp; returns</h1>
      <h2>Delivery</h2>
      <p>The delivery fee and the expected days are shown at checkout once you choose an address, before you pay. Some areas get free delivery over a set basket value; we show that too.</p>
      <h2>Payment</h2>
      <p>For now we accept bank transfer. After you place an order we hold your fabric for 24 hours while you pay. When we confirm your transfer we prepare and ship the order. Card payments are coming soon.</p>
      <h2>Returns</h2>
      <p>Fabric is cut to your order, so we can only accept returns for uncut fabric in its original condition, or for items that arrive damaged or different from what you ordered. Tell us within 48 hours of delivery and we will put it right.</p>
      <p className="small muted">These terms are a starting point and are to be confirmed by Mudassir &amp; Brothers before launch.</p>
    </div>
  );
}
