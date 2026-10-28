'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useCart } from '@/lib/cart';
import { formatMoney, trimQty, whatsappLink } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import type { ProductDetail } from '@/lib/types';
import { WishlistButton } from './WishlistButton';

const attrLabel = (k: string) => k.replace(/[_-]/g, ' ').replace(/^./, (c) => c.toUpperCase());

export function ProductView({ p }: { p: ProductDetail }) {
  const { add, store } = useCart();
  const { t, c } = useI18n();
  const title = c(p, 'title', p.title);
  const description = p.description ? c(p, 'description', p.description) : null;
  const firstAvailable = p.variants.find((v) => v.inStock) ?? p.variants[0]!;
  const [variantId, setVariantId] = useState(firstAvailable.variantId);
  const [image, setImage] = useState(0);
  const [qty, setQty] = useState('1');
  const [added, setAdded] = useState(false);

  const variant = p.variants.find((v) => v.variantId === variantId)!;
  const step = p.unit.kind === 'discrete' ? 1 : 0.5;
  const precision = p.unit.precision;
  const n = Number(qty);
  const valid = Number.isFinite(n) && n > 0 && (qty.split('.')[1]?.length ?? 0) <= precision;
  const over = valid && n > variant.available && variant.available > 0 && variant.available < 100;
  const distinguishing = useMemo(() => {
    const keys = new Set(p.variants.flatMap((v) => Object.keys(v.attributes)));
    return [...keys].filter((k) => new Set(p.variants.map((v) => v.attributes[k])).size > 1);
  }, [p.variants]);
  const wa = whatsappLink(store.contact.whatsapp, t('product.waAsk', { title }));
  const toBase = p.conversions.filter((c) => c.toCode === p.unit.code);

  const addToBasket = (quantity: string) => {
    add({ variantId: variant.variantId, productSlug: p.slug, title: p.title, i18n: p.i18n, sku: variant.sku, image: p.images[0] ?? null, unit: p.unit.code, quantity, priceMinor: variant.priceMinor });
    setAdded(true);
    setTimeout(() => setAdded(false), 2500);
  };

  return (
    <div className="pdp">
      <div className="gallery">
        <div className="main">
          {p.images[image] ? <img src={p.images[image]} alt={t('product.imageAlt', { title, n: image + 1 })} /> : <div className="placeholder" aria-hidden="true">{title.slice(0, 1)}</div>}
        </div>
        {p.images.length > 1 && (
          <div className="thumbs">
            {p.images.map((src, i) => (
              <button key={src} type="button" aria-pressed={i === image} aria-label={t('product.showImage', { n: i + 1 })} onClick={() => setImage(i)}><img src={src} alt="" /></button>
            ))}
          </div>
        )}
      </div>

      <div className="stack">
        <div>
          <nav className="small muted" aria-label={t('product.breadcrumb')}><Link href="/shop">{t('product.shop')}</Link>{p.department && <> / <Link href={`/shop?department=${p.department.slug}`}>{c(p.department, 'name', p.department.name)}</Link></>}</nav>
          {p.brand && <div className="muted">{p.brand}</div>}
          <div className="row spread"><h1 style={{ margin: 0 }}>{title}</h1><WishlistButton slug={p.slug} /></div>
          <div className="price" style={{ fontSize: '1.5rem' }} aria-live="polite">
            {formatMoney(variant.priceMinor, p.currency, store.minorUnit)} <span className="small muted">{t('product.per', { unit: p.unit.name.toLowerCase() })}{variant.taxInclusive ? t('product.taxIncluded') : t('product.taxAtCheckout')}</span>
          </div>
        </div>

        {distinguishing.map((k) => {
          const values = [...new Set(p.variants.map((v) => v.attributes[k]))];
          return (
            <div key={k} role="group" aria-label={attrLabel(k)}>
              <label>{attrLabel(k)}: <span className="muted">{variant.attributes[k]}</span></label>
              <div className="opt">
                {values.map((val) => {
                  const match = p.variants.find((v) => v.attributes[k] === val && Object.keys(variant.attributes).every((o) => o === k || v.attributes[o] === variant.attributes[o])) ?? p.variants.find((v) => v.attributes[k] === val)!;
                  return <button key={String(val)} type="button" aria-pressed={variant.attributes[k] === val} disabled={!match.inStock} onClick={() => setVariantId(match.variantId)}>{String(val)}</button>;
                })}
              </div>
            </div>
          );
        })}
        {distinguishing.length === 0 && p.variants.length > 1 && (
          <div role="group" aria-label={t('product.option')}><label>{t('product.option')}</label>
            <div className="opt">{p.variants.map((v) => <button key={v.variantId} type="button" aria-pressed={v.variantId === variantId} disabled={!v.inStock} onClick={() => setVariantId(v.variantId)}>{v.sku}</button>)}</div>
          </div>
        )}

        <div>
          {variant.inStock
            ? variant.available < 100
              ? <span className={variant.available <= 10 ? 'stock-low' : 'stock-ok'}>{t('product.onlyLeft', { n: trimQty(String(variant.available)), unit: p.unit.code })}</span>
              : <span className="stock-ok">{t('product.inStock')}</span>
            : <span className="stock-out">{t('product.soldOutMsg')}</span>}
        </div>

        {variant.inStock && (
          <form onSubmit={(e) => { e.preventDefault(); if (valid && !over) addToBasket(trimQty(qty)); }} className="stack">
            <div>
              <label htmlFor="qty">{t('product.quantity', { unit: p.unit.name.toLowerCase() })}</label>
              <div className="row">
                <div className="qty">
                  <button type="button" aria-label={t('product.decrease')} onClick={() => setQty(String(Math.max(step, Math.round((n - step) * 100) / 100)))}>−</button>
                  <input id="qty" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} aria-invalid={!valid} />
                  <button type="button" aria-label={t('product.increase')} onClick={() => setQty(String(Math.round((n + step) * 100) / 100))}>+</button>
                </div>
                {toBase.map((c) => (
                  <button key={c.fromCode} type="button" className="btn ghost small" onClick={() => addToBasket(trimQty(String(Number(c.factor))))}>
                    {t('product.addOne', { name: c.fromName.toLowerCase(), qty: trimQty(c.factor), unit: p.unit.code })}
                  </button>
                ))}
              </div>
              {!valid && <p className="err" role="alert">{precision === 0 ? t('product.enterQty') : t('product.enterQtyDecimals', { n: precision })}</p>}
              {over && <p className="err" role="alert">{t('product.weOnlyHave', { n: trimQty(String(variant.available)), unit: p.unit.code })}</p>}
              {valid && !over && <p className="small muted">{t('product.total', { amount: formatMoney(Math.round(variant.priceMinor * n), p.currency, store.minorUnit) })}</p>}
            </div>
            <div className="row">
              <button className="btn" type="submit" disabled={!valid || over}>{t('product.add')}</button>
              <Link className="btn ghost" href="/cart">{t('product.viewBasket')}</Link>
            </div>
            <p className="small ok" role="status">{added ? t('product.added') : ''}</p>
          </form>
        )}
        {wa && <a className="btn ghost" href={wa} target="_blank" rel="noopener noreferrer">{t('product.askWhatsapp')}</a>}

        {description && <div><h2>{t('product.about')}</h2><p style={{ whiteSpace: 'pre-line' }}>{description}</p></div>}
        <table className="facts"><tbody>
          {p.category && <tr><th scope="row">{t('product.category')}</th><td>{p.category}</td></tr>}
          {Object.entries(p.attributes).map(([k, v]) => <tr key={k}><th scope="row">{attrLabel(k)}</th><td>{String(v)}</td></tr>)}
          <tr><th scope="row">{t('product.soldBy')}</th><td>{p.unit.name}</td></tr>
          <tr><th scope="row">{t('product.itemCode')}</th><td>{variant.sku}</td></tr>
        </tbody></table>
      </div>
    </div>
  );
}
