'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { useAuth } from '@/lib/auth';
import { useCart } from '@/lib/cart';
import { isLang, LANGUAGES, plural, useI18n } from '@/lib/i18n';

export function Header() {
  const { store, count } = useCart();
  const { signedIn, ready } = useAuth();
  const router = useRouter();
  const { t, c, lang, setLang } = useI18n();
  const [open, setOpen] = useState(false);

  const search = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const q = String(new FormData(e.currentTarget).get('q') ?? '').trim();
    router.push(q ? `/shop?q=${encodeURIComponent(q)}` : '/shop');
    setOpen(false);
  };

  return (
    <>
      <a className="skip" href="#main">{t('skip')}</a>
      {store.tagline && <div className="topbar">{c(store, 'tagline', store.tagline)}</div>}
      <header className="header">
        <div className="wrap">
          <button className="iconbtn menu-toggle" aria-label={t('menu')} aria-expanded={open} aria-controls="nav" onClick={() => setOpen(!open)}>☰</button>
          <Link href="/" className="logo">{store.name}</Link>
          <nav id="nav" className={`nav${open ? ' open' : ''}`} aria-label="Main">
            <Link href="/shop" onClick={() => setOpen(false)}>{t('nav.shopAll')}</Link>
            {store.departments.slice(0, 4).map((d) => (
              <Link key={d.slug} href={`/shop?department=${d.slug}`} onClick={() => setOpen(false)}>{c(d, 'name', d.name)}</Link>
            ))}
            <Link href="/about" onClick={() => setOpen(false)}>{t('nav.story')}</Link>
            <Link href="/contact" onClick={() => setOpen(false)}>{t('nav.contact')}</Link>
          </nav>
          <form className="search" role="search" onSubmit={search}>
            <input name="q" type="search" placeholder={t('search.placeholder')} aria-label={t('search.label')} />
          </form>
          <div className="icons">
            <Link className="iconbtn" href={signedIn ? '/account/wishlist' : '/login?next=/account/wishlist'} aria-label={t('wishlist')}>♡</Link>
            <Link className="iconbtn" href={ready && signedIn ? '/account' : '/login'} aria-label={signedIn ? t('account.yours') : t('signIn')}>👤</Link>
            <Link className="iconbtn" href="/cart" aria-label={t(plural('basket.label', count), { n: count })}>
              🛍{count > 0 && <span className="badge" aria-hidden="true">{count}</span>}
            </Link>
            <select className="lang" aria-label={t('language')} value={lang} onChange={(e) => { if (isLang(e.target.value)) setLang(e.target.value); }}>
              {LANGUAGES.map((l) => <option key={l.code} value={l.code} lang={l.code}>{l.label}</option>)}
            </select>
          </div>
        </div>
      </header>
    </>
  );
}
