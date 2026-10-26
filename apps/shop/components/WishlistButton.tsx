'use client';

import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import { useWishlist } from '@/lib/wishlist';

export function WishlistButton({ slug, className = 'iconbtn' }: { slug: string; className?: string }) {
  const { slugs, toggle } = useWishlist();
  const router = useRouter();
  const { signedIn } = useAuth();
  const on = slugs.has(slug);
  return (
    <button
      type="button"
      className={className}
      aria-pressed={on}
      aria-label={on ? 'Remove from wishlist' : 'Save to wishlist'}
      onClick={async () => { if ((await toggle(slug)) === 'needs-login') router.push(signedIn ? '/account' : `/login?next=${encodeURIComponent(`/product/${slug}`)}`); }}
    >
      {on ? '♥' : '♡'}
    </button>
  );
}
