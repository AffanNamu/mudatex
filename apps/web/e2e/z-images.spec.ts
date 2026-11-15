import { deflateSync } from 'node:zlib';
import { expect, test } from '@playwright/test';
import { noA11yViolations, signIn } from './helpers';

const nav = (page: import('@playwright/test').Page, name: string) => page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name }).click();

/** A real PNG with a colour gradient, big enough to need shrinking, made without any image library. */
function png(width: number, height: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => { const t = Buffer.from(type); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, sum]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const row = (y: number) => { const r = Buffer.alloc(1 + width * 3); for (let x = 0; x < width; x++) { r[1 + x * 3] = (x * 255 / width) | 0; r[2 + x * 3] = (y * 255 / height) | 0; r[3 + x * 3] = 120; } return r; };
  const raw = Buffer.concat(Array.from({ length: height }, (_, y) => row(y)));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// Last on purpose: it changes a product's pictures.
test('staff add product photos from a file, the photo is shrunk, and the shop shows it', async ({ page, request }) => {
  test.skip((await request.get('http://localhost:3100/shop/console-shop')).status() !== 200, 'needs the store from the online-store tests');
  const big = png(2400, 1800);
  expect(big.length).toBeGreaterThan(20_000);

  await signIn(page, 'admin@e2e.test');
  await nav(page, 'Online store');
  await page.getByRole('row', { name: /Ankara Wax Print/ }).getByRole('button', { name: 'Edit' }).click();
  const listing = page.getByRole('form', { name: /Online listing for Ankara Wax Print/ });
  await expect(listing.getByRole('img', { name: /picture 1 \(main\)/ })).toBeVisible();   // the picture link from the earlier test

  await listing.getByLabel('Pictures: choose files').setInputFiles({ name: 'ankara-front.png', mimeType: 'image/png', buffer: big });
  await expect(listing.getByRole('img', { name: /picture 2/ })).toBeVisible();
  const src = await listing.getByRole('img', { name: /picture 2/ }).getAttribute('src');
  expect(src).toMatch(/\/images\/[0-9a-f-]{36}$/);

  // what was stored is a smaller WebP (or JPEG), not the original
  const stored = await request.get(src!);
  expect(stored.status()).toBe(200);
  expect(['image/webp', 'image/jpeg']).toContain(stored.headers()['content-type']);
  expect((await stored.body()).length).toBeLessThan(big.length);

  // put the new picture first, remove the link, and publish
  await listing.getByRole('button', { name: 'Move picture 2 earlier' }).click();
  await listing.getByRole('button', { name: 'Remove picture 2' }).click();
  await noA11yViolations(page);
  await listing.getByRole('button', { name: 'Save listing' }).click();
  await expect(page.getByRole('row', { name: /Ankara Wax Print/ })).toContainText('Published');

  const product = await (await request.get('http://localhost:3100/shop/console-shop/products/ankara-wax-print')).json();
  expect(product.images).toEqual([src]);
  // anyone can fetch it, and the browser may keep it for a year
  const bytes = await request.get(product.images[0]);
  expect(bytes.status()).toBe(200);
  expect(bytes.headers()['cache-control']).toContain('immutable');
});
