'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { RequireShopper } from '@/components/RequireShopper';
import { useAuth } from '@/lib/auth';

const TABS = [['/account', 'Profile'], ['/account/orders', 'Orders'], ['/account/addresses', 'Addresses'], ['/account/wishlist', 'Wishlist'], ['/trade', 'Trade account']] as const;

export default function AccountLayout({ children }: { children: ReactNode }) {
  const path = usePathname();
  const { signOut } = useAuth();
  return (
    <div className="wrap section">
      <RequireShopper>
        <div className="row spread"><h1>My account</h1><button className="btn ghost small" onClick={signOut}>Sign out</button></div>
        <nav className="tabs" aria-label="Account">
          {TABS.map(([href, label]) => <Link key={href} href={href} aria-current={path === href ? 'page' : undefined}>{label}</Link>)}
        </nav>
        {children}
      </RequireShopper>
    </div>
  );
}
