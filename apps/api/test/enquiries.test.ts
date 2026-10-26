import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, setupApp, staff } from './helpers.js';
import { goLive, shopWorld } from './shop-helpers.js';

let ctx: Awaited<ReturnType<typeof setupApp>>;
beforeAll(async () => { ctx = await setupApp(); });
afterAll(async () => { await ctx.close(); });

const valid = { kind: 'wholesale', name: 'Hajiya Zainab', phone: '+2348030000000', company: 'Zainab Fabrics', message: 'We buy 200 rolls of Atampa a month. Please send your wholesale prices.' };

describe('enquiries from the public site', () => {
  it('accepts a message without sign-in and shows it to staff who may handle it', async () => {
    const s = await shopWorld(ctx);
    await goLive(ctx, s);
    const sent = await call(ctx.app, 'POST', `/shop/${s.slug}/enquiries`, undefined, valid);
    expect(sent.status).toBe(202);
    expect(sent.body.reference).toMatch(/^[0-9A-F]{8}$/);
    const inbox = await call(ctx.app, 'GET', '/v1/enquiries?status=new', s.a);
    expect(inbox.body).toEqual([expect.objectContaining({ kind: 'wholesale', name: 'Hajiya Zainab', company: 'Zainab Fabrics', status: 'new', storeName: 'Test Shop' })]);
    const id = inbox.body[0].id;
    const done = await call(ctx.app, 'POST', `/v1/enquiries/${id}/status`, s.a, { status: 'closed', note: 'Called back, sent the price list' });
    expect(done.body).toMatchObject({ status: 'closed', note: 'Called back, sent the price list' });
    expect((await call(ctx.app, 'GET', '/v1/enquiries?status=new', s.a)).body).toEqual([]);
  });

  it('needs a way to reply, a real message and a live store; drops what bots fill in', async () => {
    const s = await shopWorld(ctx);
    expect((await call(ctx.app, 'POST', `/shop/${s.slug}/enquiries`, undefined, valid)).status).toBe(404);
    await goLive(ctx, s);
    const post = (b: object) => call(ctx.app, 'POST', `/shop/${s.slug}/enquiries`, undefined, b);
    expect((await post({ ...valid, phone: undefined })).status).toBe(400);
    expect((await post({ ...valid, message: 'hi' })).status).toBe(400);
    expect((await post({ ...valid, kind: 'spam' })).status).toBe(400);
    expect((await post({ ...valid, message: 'x'.repeat(3001) })).status).toBe(400);
    const bot = await post({ ...valid, website: 'http://spam.example' });
    expect(bot.status).toBe(202);
    expect((await call(ctx.app, 'GET', '/v1/enquiries', s.a)).body).toEqual([]);
  });

  it('is limited to staff with the permission and to their legal entity', async () => {
    const s = await shopWorld(ctx);
    await goLive(ctx, s);
    await call(ctx.app, 'POST', `/shop/${s.slug}/enquiries`, undefined, { ...valid, kind: 'contact', email: 'a@example.test' });
    const inbox = (await call(ctx.app, 'GET', '/v1/enquiries', s.a)).body;
    const none = await staff(ctx.app, s.a, ['catalog.read'], { type: 'group' });
    expect((await call(ctx.app, 'GET', '/v1/enquiries', none.auth)).body).toEqual([]);
    expect((await call(ctx.app, 'POST', `/v1/enquiries/${inbox[0].id}/status`, none.auth, { status: 'closed' })).status).toBe(403);
    const gh = await staff(ctx.app, s.a, ['enquiries.manage'], { type: 'legal_entity', id: s.w.gh });
    expect((await call(ctx.app, 'GET', '/v1/enquiries', gh.auth)).body).toEqual([]);
    expect((await call(ctx.app, 'POST', `/v1/enquiries/${inbox[0].id}/status`, gh.auth, { status: 'closed' })).status).toBe(403);
    const ng = await staff(ctx.app, s.a, ['enquiries.manage'], { type: 'legal_entity', id: s.w.ng });
    expect((await call(ctx.app, 'GET', '/v1/enquiries', ng.auth)).body).toHaveLength(1);
  });
});
