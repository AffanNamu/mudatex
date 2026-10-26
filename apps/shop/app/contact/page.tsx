import type { Metadata } from 'next';
import { getStore } from '@/lib/api';
import { whatsappLink } from '@/lib/format';

export const metadata: Metadata = { title: 'Contact us' };

export default async function Contact() {
  const store = await getStore();
  if (!store) return null;
  const c = store.contact;
  const wa = whatsappLink(c.whatsapp, `Hello ${store.name}, I have a question.`);
  return (
    <div className="wrap section prose">
      <h1>Contact us</h1>
      <p>We reply fastest on WhatsApp. For orders, please have your order number ready.</p>
      <div className="card stack">
        {wa && <p><a className="btn" href={wa} target="_blank" rel="noopener noreferrer">Chat on WhatsApp</a></p>}
        {c.phone && <p><strong>Phone:</strong> <a href={`tel:${c.phone.replace(/\s/g, '')}`}>{c.phone}</a></p>}
        {c.email && <p><strong>Email:</strong> <a href={`mailto:${c.email}`}>{c.email}</a></p>}
        {c.address && <p><strong>Visit us:</strong> {c.address}</p>}
        {!wa && !c.phone && !c.email && !c.address && <p className="muted">Contact details will be added soon.</p>}
      </div>
    </div>
  );
}
