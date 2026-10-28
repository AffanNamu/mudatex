import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { Footer } from '@/components/Footer';
import { Header } from '@/components/Header';
import { Providers } from '@/components/Providers';
import { getStore } from '@/lib/api';
import { SITE_URL } from '@/lib/config';
import './globals.css';

export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#1f2a5c' };

export async function generateMetadata(): Promise<Metadata> {
  const store = await getStore();
  const name = store?.name ?? 'Mudatex';
  return {
    metadataBase: new URL(SITE_URL),
    title: { default: `${name} — premium textiles, lace and fabrics`, template: `%s | ${name}` },
    description: store?.tagline ?? 'Premium African textiles, lace and fabrics, delivered across Nigeria.',
    openGraph: { siteName: name, type: 'website' },
    appleWebApp: { capable: true, title: name, statusBarStyle: 'default' },
    icons: { icon: '/icons/icon-192.png', apple: '/icons/icon-180.png' },
  };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const store = await getStore();
  return (
    <html lang="en">
      <body>
        {store ? (
          <Providers store={store}>
            <Header />
            <main id="main">{children}</main>
            <Footer store={store} />
          </Providers>
        ) : (
          <main id="main" className="wrap empty">
            <h1>We&apos;ll be right back</h1>
            <p className="muted">The shop is not open right now. Please check again shortly.</p>
          </main>
        )}
      </body>
    </html>
  );
}
