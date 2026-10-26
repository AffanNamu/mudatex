import type { Metadata } from 'next';
import { EnquiryForm } from '@/components/EnquiryForm';
import { getStore } from '@/lib/api';
import { whatsappLink } from '@/lib/format';

export const metadata: Metadata = { title: 'Contact us' };

export default async function Contact() {
  const store = await getStore();
  if (!store) return null;
  const c = store.contact;
  const wa = whatsappLink(c.whatsapp, `Hello ${store.name}, I have a question.`);
  return (
    <div className="wrap section">
      <h1>Contact us</h1>
      <div className="cartgrid">
        <div>
          <p>We reply fastest on WhatsApp. For an order, please have the order number ready.</p>
          <EnquiryForm kind="contact" messageLabel="How can we help?" />
        </div>
        <aside className="card stack" aria-label="Ways to reach us">
          {wa && <p><a className="btn block" href={wa} target="_blank" rel="noopener noreferrer">Chat on WhatsApp</a></p>}
          {c.phone && <p><strong>Phone:</strong> <a href={`tel:${c.phone.replace(/\s/g, '')}`}>{c.phone}</a></p>}
          {c.email && <p><strong>Email:</strong> <a href={`mailto:${c.email}`}>{c.email}</a></p>}
          {c.address && <p><strong>Visit us:</strong> {c.address}</p>}
        </aside>
      </div>
    </div>
  );
}
