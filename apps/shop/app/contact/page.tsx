import type { Metadata } from 'next';
import { EnquiryForm } from '@/components/EnquiryForm';
import { getStore } from '@/lib/api';
import { whatsappLink } from '@/lib/format';
import { T } from '@/lib/i18n';

export const metadata: Metadata = { title: 'Contact us' };

export default async function Contact() {
  const store = await getStore();
  if (!store) return null;
  const c = store.contact;
  const wa = whatsappLink(c.whatsapp, `Hello ${store.name}, I have a question.`);
  return (
    <div className="wrap section">
      <h1><T k="contact.title" /></h1>
      <div className="cartgrid">
        <div>
          <p><T k="contact.lead" /></p>
          <EnquiryForm kind="contact" messageLabel="contact.howHelp" />
        </div>
        <aside className="card stack" aria-label="Ways to reach us">
          {wa && <p><a className="btn block" href={wa} target="_blank" rel="noopener noreferrer"><T k="contact.chat" /></a></p>}
          {c.phone && <p><strong><T k="contact.phone" /></strong> <a href={`tel:${c.phone.replace(/\s/g, '')}`}>{c.phone}</a></p>}
          {c.email && <p><strong><T k="contact.email" /></strong> <a href={`mailto:${c.email}`}>{c.email}</a></p>}
          {c.address && <p><strong><T k="contact.visit" /></strong> {c.address}</p>}
        </aside>
      </div>
    </div>
  );
}
