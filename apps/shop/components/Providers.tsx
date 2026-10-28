'use client';

import type { ReactNode } from 'react';
import { AuthProvider } from '@/lib/auth';
import { CartProvider } from '@/lib/cart';
import { I18nProvider } from '@/lib/i18n';
import type { Store } from '@/lib/types';
import { WishlistProvider } from '@/lib/wishlist';

export function Providers({ store, children }: { store: Store; children: ReactNode }) {
  return (
    <I18nProvider>
      <AuthProvider>
        <WishlistProvider>
          <CartProvider store={store}>{children}</CartProvider>
        </WishlistProvider>
      </AuthProvider>
    </I18nProvider>
  );
}
