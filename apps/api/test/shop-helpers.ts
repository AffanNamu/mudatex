import { expect } from 'vitest';
import { call, newOrg, token, type setupApp } from './helpers.js';
import { buildWorld } from './inventory-helpers.js';
import { buildPosWorld } from './pos-helpers.js';

type Ctx = Awaited<ReturnType<typeof setupApp>>;

export const uniq = () => crypto.randomUUID().slice(0, 8);

export async function shopWorld(ctx: Ctx) {
  const w = await buildPosWorld(ctx.app, await buildWorld(ctx.app, await newOrg(ctx.db)));
  const a = w.org.auth;
  const slug = `shop-${uniq()}`;
  const sf = await call(ctx.app, 'POST', '/v1/storefronts', a, {
    legalEntityId: w.ng, slug, name: 'Test Shop', priceListId: w.priceList, stockLocationIds: [w.shop],
    contact: { whatsapp: '+2348000000000' },
  });
  expect(sf.status).toBe(201);
  const id = sf.body.id as string;
  const dept = await call(ctx.app, 'POST', `/v1/storefronts/${id}/departments`, a, { slug: 'fabrics', name: 'Fabrics' });
  expect(dept.status).toBe(201);
  const publish = (productId: string, body: Record<string, unknown> = {}) => call(ctx.app, 'PUT', `/v1/storefronts/${id}/products/${productId}`, a, body);
  return { w, a, id, slug, deptId: dept.body.id as string, publish };
}
export type Shop = Awaited<ReturnType<typeof shopWorld>>;

export async function goLive(ctx: Ctx, s: Shop) {
  const p = await s.publish(s.w.fabric.productId, { slug: 'ankara-wax', title: 'Ankara Wax', brand: 'Empire', departmentId: s.deptId, images: ['https://img.example.test/a.jpg'], badges: ['New'], published: true });
  expect(p.status).toBe(200);
  const live = await call(ctx.app, 'PUT', `/v1/storefronts/${s.id}`, s.a, { status: 'live' });
  expect(live.status).toBe(200);
}


export async function shopper(email: string) {
  const sub = `cust-${uniq()}`;
  return { sub, email, auth: { authorization: `Bearer ${await token(sub, { email })}` } };
}
