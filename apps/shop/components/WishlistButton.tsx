'use client';

import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { useWishlist } from '@/lib/wishlist';

export function WishlistButton({ slug, className = 'iconbtn' }: { slug: string; className?: string }) {
  const { slugs, toggle } = useWishlist();
  const router = useRouter();
  const { signedIn, ready, profile } = useAuth();
  // Until the saved sign-in and the shopper's profile have loaded, a tap would be sent to the sign-in page by mistake.
  const pending = !ready || (signedIn && profile === 'loading');
  const { t } = useI18n();
  const on = slugs.has(slug);
  return (
    <button
      type="button"
      className={className}
      aria-pressed={on}
      disabled={pending}
      aria-label={on ? t('wishlist.remove') : t('wishlist.save')}
      onClick={async () => { if ((await toggle(slug)) === 'needs-login') router.push(signedIn ? '/account' : `/login?next=${encodeURIComponent(`/product/${slug}`)}`); }}
    >
      {on ? '♥' : '♡'}
    </button>
  );
}
