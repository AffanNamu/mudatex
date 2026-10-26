'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { useAuth } from '@/lib/auth';
import { useCart } from '@/lib/cart';

export function Header() {
  const { store, count } = useCart();
  const { signedIn, ready } = useAuth();
  const router = useRouter();
  const [open, setOpen] = useState(false);

  const search = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const q = String(new FormData(e.currentTarget).get('q') ?? '').trim();
    router.push(q ? `/shop?q=${encodeURIComponent(q)}` : '/shop');
    setOpen(false);
  };

  return (
    <>
      <a className="skip" href="#main">Skip to content</a>
      {store.tagline && <div className="topbar">{store.tagline}</div>}
      <header className="header">
        <div className="wrap">
          <button className="iconbtn menu-toggle" aria-label="Menu" aria-expanded={open} aria-controls="nav" onClick={() => setOpen(!open)}>☰</button>
          <Link href="/" className="logo">{store.name}</Link>
          <nav id="nav" className={`nav${open ? ' open' : ''}`} aria-label="Main">
            <Link href="/shop" onClick={() => setOpen(false)}>Shop all</Link>
            {store.departments.slice(0, 4).map((d) => (
              <Link key={d.slug} href={`/shop?department=${d.slug}`} onClick={() => setOpen(false)}>{d.name}</Link>
            ))}
            <Link href="/about" onClick={() => setOpen(false)}>Our story</Link>
            <Link href="/contact" onClick={() => setOpen(false)}>Contact</Link>
          </nav>
          <form className="search" role="search" onSubmit={search}>
            <input name="q" type="search" placeholder="Search fabrics, brands…" aria-label="Search the shop" />
          </form>
          <div className="icons">
            <Link className="iconbtn" href={signedIn ? '/account/wishlist' : '/login?next=/account/wishlist'} aria-label="Wishlist">♡</Link>
            <Link className="iconbtn" href={ready && signedIn ? '/account' : '/login'} aria-label={signedIn ? 'Your account' : 'Sign in'}>👤</Link>
            <Link className="iconbtn" href="/cart" aria-label={`Basket, ${count} ${count === 1 ? 'item' : 'items'}`}>
              🛍{count > 0 && <span className="badge" aria-hidden="true">{count}</span>}
            </Link>
          </div>
        </div>
      </header>
    </>
  );
}
