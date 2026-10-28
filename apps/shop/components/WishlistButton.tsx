'use client';

import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { useWishlist } from '@/lib/wishlist';

export function WishlistButton({ slug, className = 'iconbtn' }: { slug: string; className?: string }) {
  const { slugs, toggle } = useWishlist();
  const router = useRouter();
  const { signedIn } = useAuth();
  const { t } = useI18n();
  const on = slugs.has(slug);
  return (
    <button
      type="button"
      className={className}
      aria-pressed={on}
      aria-label={on ? t('wishlist.remove') : t('wishlist.save')}
      onClick={async () => { if ((await toggle(slug)) === 'needs-login') router.push(signedIn ? '/account' : `/login?next=${encodeURIComponent(`/product/${slug}`)}`); }}
    >
      {on ? '♥' : '♡'}
    </button>
  );
}
