'use client';

import Link from 'next/link';
import { whatsappLink } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { PwaSupport } from './PwaSupport';
import type { Store } from '@/lib/types';

export function Footer({ store }: { store: Store }) {
  const { t } = useI18n();
  const wa = whatsappLink(store.contact.whatsapp, t('footer.waHello', { name: store.name }));
  return (
    <>
      <footer className="footer">
        <div className="wrap">
          <div className="cols">
            <div>
              <h3>{store.name}</h3>
              <p>{store.tagline ?? t('footer.tagline')}</p>
              {store.contact.address && <p className="small">{store.contact.address}</p>}
            </div>
            <div>
              <h3>{t('footer.shop')}</h3>
              <ul>
                <li><Link href="/shop">{t('footer.allProducts')}</Link></li>
                {store.departments.map((d) => <li key={d.slug}><Link href={`/shop?department=${d.slug}`}>{d.name}</Link></li>)}
              </ul>
            </div>
            <div>
              <h3>{t('footer.help')}</h3>
              <ul>
                <li><Link href="/contact">{t('footer.contactUs')}</Link></li>
                <li><Link href="/account/orders">{t('footer.trackOrder')}</Link></li>
                <li><Link href="/delivery">{t('footer.deliveryReturns')}</Link></li>
                <li><Link href="/wholesale">{t('footer.wholesale')}</Link></li>
                <li><Link href="/custom-orders">{t('footer.madeToOrder')}</Link></li>
              </ul>
            </div>
            <div>
              <h3>{t('footer.company')}</h3>
              <ul>
                <li><Link href="/about">{t('footer.story')}</Link></li>
                <li><Link href="/divisions">{t('footer.whatWeDo')}</Link></li>
                <li><Link href="/brands">{t('footer.brands')}</Link></li>
                <li><Link href="/locations">{t('footer.findUs')}</Link></li>
                <li><Link href="/careers">{t('footer.careers')}</Link></li>
              </ul>
              <h3 style={{ marginTop: 16 }}>{t('footer.reachUs')}</h3>
              <ul>
                {store.contact.phone && <li><a href={`tel:${store.contact.phone.replace(/\s/g, '')}`}>{store.contact.phone}</a></li>}
                {store.contact.email && <li><a href={`mailto:${store.contact.email}`}>{store.contact.email}</a></li>}
                {wa && <li><a href={wa}>{t('footer.whatsappUs')}</a></li>}
              </ul>
            </div>
          </div>
          <div className="legal row spread"><span>{t('footer.rights', { year: new Date().getFullYear(), name: store.name })}</span><PwaSupport /></div>
        </div>
      </footer>
      {wa && <a className="wa" href={wa} aria-label={t('footer.waLabel')} target="_blank" rel="noopener noreferrer">💬</a>}
    </>
  );
}
