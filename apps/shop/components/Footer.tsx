import Link from 'next/link';
import { whatsappLink } from '@/lib/format';
import type { Store } from '@/lib/types';

export function Footer({ store }: { store: Store }) {
  const wa = whatsappLink(store.contact.whatsapp, `Hello ${store.name}, I need help with an order.`);
  return (
    <>
      <footer className="footer">
        <div className="wrap">
          <div className="cols">
            <div>
              <h3>{store.name}</h3>
              <p>{store.tagline ?? 'Quality textiles, delivered.'}</p>
              {store.contact.address && <p className="small">{store.contact.address}</p>}
            </div>
            <div>
              <h3>Shop</h3>
              <ul>
                <li><Link href="/shop">All products</Link></li>
                {store.departments.map((d) => <li key={d.slug}><Link href={`/shop?department=${d.slug}`}>{d.name}</Link></li>)}
              </ul>
            </div>
            <div>
              <h3>Help</h3>
              <ul>
                <li><Link href="/contact">Contact us</Link></li>
                <li><Link href="/account/orders">Track an order</Link></li>
                <li><Link href="/delivery">Delivery &amp; returns</Link></li>
                <li><Link href="/wholesale">Wholesale</Link></li>
                <li><Link href="/custom-orders">Made to order</Link></li>
              </ul>
            </div>
            <div>
              <h3>Company</h3>
              <ul>
                <li><Link href="/about">Our story</Link></li>
                <li><Link href="/divisions">What we do</Link></li>
                <li><Link href="/brands">Our brands</Link></li>
                <li><Link href="/locations">Find us</Link></li>
                <li><Link href="/careers">Careers</Link></li>
              </ul>
              <h3 style={{ marginTop: 16 }}>Reach us</h3>
              <ul>
                {store.contact.phone && <li><a href={`tel:${store.contact.phone.replace(/\s/g, '')}`}>{store.contact.phone}</a></li>}
                {store.contact.email && <li><a href={`mailto:${store.contact.email}`}>{store.contact.email}</a></li>}
                {wa && <li><a href={wa}>WhatsApp us</a></li>}
              </ul>
            </div>
          </div>
          <div className="legal">© {new Date().getFullYear()} {store.name}. All rights reserved.</div>
        </div>
      </footer>
      {wa && <a className="wa" href={wa} aria-label="Chat with us on WhatsApp" target="_blank" rel="noopener noreferrer">💬</a>}
    </>
  );
}
