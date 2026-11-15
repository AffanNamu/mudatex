import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { purgeOrphanImages, sniffImage } from '../src/routes/images.js';
import { call, newOrg, setupApp, staff } from './helpers.js';
import { goLive, shopWorld, uniq } from './shop-helpers.js';

// A real 1x1 PNG, a tiny JPEG header and a WebP header: enough to be recognised by their first bytes.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const jpeg = (n = 40) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(n, 1)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x20, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(20, 2)]);

let ctx: Awaited<ReturnType<typeof setupApp>>;
beforeAll(async () => { ctx = await setupApp({ IMAGE_QUOTA_MB: '1' }); });
afterAll(async () => { await ctx.close(); });

const upload = (headers: Record<string, string>, body: Buffer, type = 'image/png') =>
  ctx.app.inject({ method: 'POST', url: '/v1/images', headers: { ...headers, 'content-type': type, host: 'api.example.test' }, payload: body });

describe('recognising pictures by their bytes', () => {
  it('knows JPEG, PNG and WebP and nothing else, whatever the file says it is', () => {
    expect(sniffImage(PNG)).toBe('image/png');
    expect(sniffImage(jpeg())).toBe('image/jpeg');
    expect(sniffImage(WEBP)).toBe('image/webp');
    expect(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).toBeNull();
    expect(sniffImage(Buffer.from('GIF89a......'))).toBeNull();
    expect(sniffImage(Buffer.from('<html><body>hi</body></html>'))).toBeNull();
    expect(sniffImage(Buffer.alloc(0))).toBeNull();
  });
});

describe('product photos', () => {
  it('are uploaded by staff, served to anyone with long caching, and the same picture is stored once', async () => {
    const org = await newOrg(ctx.db);
    const up = await upload(org.auth, PNG);
    expect(up.statusCode).toBe(201);
    const { id, url } = up.json();
    expect(url).toMatch(new RegExp(`/images/${id}$`));
    expect(url.startsWith('http://api.example.test/images/')).toBe(true);
    expect((await upload(org.auth, PNG)).json().id).toBe(id);   // again: same picture, same address, 200

    const got = await ctx.app.inject({ method: 'GET', url: `/images/${id}` });   // no sign-in
    expect(got.statusCode).toBe(200);
    expect(got.headers['content-type']).toBe('image/png');
    expect(got.headers['cache-control']).toContain('immutable');
    expect(got.headers['x-content-type-options']).toBe('nosniff');
    expect(got.headers['content-security-policy']).toContain('sandbox');
    expect(got.rawPayload.equals(PNG)).toBe(true);
    const again = await ctx.app.inject({ method: 'GET', url: `/images/${id}`, headers: { 'if-none-match': got.headers.etag as string } });
    expect(again.statusCode).toBe(304);
    expect((await ctx.app.inject({ method: 'GET', url: `/images/${crypto.randomUUID()}` })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: 'GET', url: '/images/not-an-id' })).statusCode).toBe(404);
  });

  it('are refused when they are not pictures, are too big, or come from people who may not publish', async () => {
    const org = await newOrg(ctx.db);
    expect((await upload({}, PNG)).statusCode).toBe(401);
    expect((await upload(org.auth, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'image/png')).statusCode).toBe(415);   // an SVG pretending to be a PNG
    expect((await upload(org.auth, Buffer.from('<svg/>'), 'image/svg+xml')).statusCode).toBe(415);
    expect((await upload(org.auth, Buffer.alloc(2_100_000, 1), 'image/jpeg')).statusCode).toBe(413);
    expect((await upload(org.auth, Buffer.alloc(0))).statusCode).toBeGreaterThanOrEqual(400);
    const s = await shopWorld(ctx);
    const reader = await staff(ctx.app, s.a, ['orders.read'], { type: 'legal_entity', id: s.w.ng });
    expect((await upload(reader.auth, PNG)).statusCode).toBe(403);
    const manager = await staff(ctx.app, s.a, ['storefront.manage'], { type: 'legal_entity', id: s.w.ng });
    expect((await upload(manager.auth, PNG)).statusCode).toBe(201);
  });

  it('stop at the company\'s quota, and say how much is used', async () => {
    const org = await newOrg(ctx.db);
    for (let i = 0; i < 1; i++) expect((await upload(org.auth, jpeg(900_000 + i))).statusCode).toBe(201);
    const full = await upload(org.auth, jpeg(300_000), 'image/jpeg');
    expect(full.statusCode).toBe(413);
    expect(full.json().error).toBe('quota');
    const usage = await call(ctx.app, 'GET', '/v1/images/usage', org.auth);
    expect(usage.body).toMatchObject({ count: 1, quotaBytes: 1_000_000 });
    expect(usage.body.bytes).toBeGreaterThan(900_000);
  });

  it('can be used as a product\'s picture, and a picture nobody uses is cleared out after two days', async () => {
    const s = await shopWorld(ctx);
    await goLive(ctx, s);
    const tag = uniq();
    const used = (await upload(s.a, jpeg(50 + tag.length), 'image/jpeg')).json();
    const unused = (await upload(s.a, jpeg(70 + tag.length), 'image/jpeg')).json();
    const put = await call(ctx.app, 'PUT', `/v1/storefronts/${s.id}/products/${s.w.fabric.productId}`, s.a, { images: [used.url.replace('http://api.example.test', 'http://localhost:3100')] });
    expect(put.status).toBe(200);
    await ctx.db.query(`UPDATE images SET created_at = now() - interval '3 days' WHERE id = ANY($1)`, [[used.id, unused.id]]);
    await purgeOrphanImages(ctx.db);
    const left = await ctx.db.query(`SELECT id FROM images WHERE id = ANY($1)`, [[used.id, unused.id]]);
    expect(left.rows.map((r) => r.id)).toEqual([used.id]);
    // a fresh upload is kept even if nothing uses it yet (a form may still be open)
    const fresh = (await upload(s.a, jpeg(90 + tag.length), 'image/jpeg')).json();
    await purgeOrphanImages(ctx.db);
    expect((await ctx.db.query('SELECT 1 FROM images WHERE id = $1', [fresh.id])).rowCount).toBe(1);
  });
});
