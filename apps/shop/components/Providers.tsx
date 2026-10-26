'use client';

import type { ReactNode } from 'react';
import { AuthProvider } from '@/lib/auth';
import { CartProvider } from '@/lib/cart';
import type { Store } from '@/lib/types';
import { WishlistProvider } from '@/lib/wishlist';

export function Providers({ store, children }: { store: Store; children: ReactNode }) {
  return (
    <AuthProvider>
      <WishlistProvider>
        <CartProvider store={store}>{children}</CartProvider>
      </WishlistProvider>
    </AuthProvider>
  );
}
