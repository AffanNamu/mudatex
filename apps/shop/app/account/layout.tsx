'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { RequireShopper } from '@/components/RequireShopper';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';

const TABS = [['/account', 'account.tab.profile'], ['/account/orders', 'account.tab.orders'], ['/account/addresses', 'account.tab.addresses'], ['/account/wishlist', 'account.tab.wishlist'], ['/trade', 'account.tab.trade']] as const;

export default function AccountLayout({ children }: { children: ReactNode }) {
  const path = usePathname();
  const { signOut } = useAuth();
  const { t } = useI18n();
  return (
    <div className="wrap section">
      <RequireShopper>
        <div className="row spread"><h1>{t('account.title')}</h1><button className="btn ghost small" onClick={signOut}>{t('account.signOut')}</button></div>
        <nav className="tabs" aria-label={t('account.nav')}>
          {TABS.map(([href, label]) => <Link key={href} href={href} aria-current={path === href ? 'page' : undefined}>{t(label)}</Link>)}
        </nav>
        {children}
      </RequireShopper>
    </div>
  );
}
