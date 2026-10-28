import type { MetadataRoute } from 'next';
import { getStore } from '@/lib/api';

export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const store = await getStore();
  const name = store?.name ?? 'Mudatex';
  return {
    name,
    short_name: name.length > 14 ? name.split(' ')[0]! : name,
    description: store?.tagline ?? 'Premium textiles, lace and fabrics, delivered.',
    start_url: '/?source=pwa',
    scope: '/',
    display: 'standalone',
    background_color: '#fbf8f2',
    theme_color: '#1f2a5c',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    shortcuts: [
      { name: 'Shop all', url: '/shop' },
      { name: 'Basket', url: '/cart' },
      { name: 'My orders', url: '/account/orders' },
    ],
  };
}
