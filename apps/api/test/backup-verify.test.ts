import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyDatabase } from '../src/backup-verify.js';
import { call, setupApp } from './helpers.js';
import { goLive, shopWorld, shopper, uniq } from './shop-helpers.js';

let ctx: Awaited<ReturnType<typeof setupApp>>;
beforeAll(async () => { ctx = await setupApp(); });
afterAll(async () => { await ctx.close(); });

describe('checking a restored database', () => {
  it('passes a database that has had real use, and reports what is in it', async () => {
    const s = await shopWorld(ctx);
    await goLive(ctx, s);
    await call(ctx.app, 'PUT', `/v1/storefronts/${s.id}`, s.a, { contact: { bankName: 'Test Bank', accountName: 'Textiles Ltd', accountNumber: '0123456789' } });
    await call(ctx.app, 'POST', `/v1/storefronts/${s.id}/delivery-zones`, s.a, { name: 'All', countryCode: 'NG', feeMinor: 100000 });
    const c = await shopper(`bk-${uniq()}@example.test`);
    await call(ctx.app, 'POST', `/shop/${s.slug}/me`, c.auth, { fullName: 'Amina Yusuf', phone: '+2348011111111' });
    const addr = await call(ctx.app, 'POST', `/shop/${s.slug}/me/addresses`, c.auth, { label: 'H', recipient: 'Amina Yusuf', phone: '+2348011111111', line1: '1 Road', city: 'Kano', state: 'Kano', countryCode: 'NG' });
    const o = await call(ctx.app, 'POST', `/shop/${s.slug}/me/orders`, { ...c.auth, 'idempotency-key': crypto.randomUUID() }, { lines: [{ variantId: s.w.fabric.variantId, quantity: '1' }], addressId: addr.body.id, paymentMethod: 'bank_transfer' });
    expect(o.status).toBe(201);
    await call(ctx.app, 'POST', `/v1/sales-orders/${o.body.id}/payments`, s.a, { method: 'bank_transfer', reference: `BK-${uniq()}`, amountMinor: o.body.totalMinor });
    const v = await verifyDatabase(ctx.db);
    expect(v.checks.filter((x) => !x.ok)).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.counts.sales_orders).toBeGreaterThan(0);
  });

  it('says what is wrong when a copy is damaged', async () => {
    const client = await ctx.db.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO schema_migrations (name, checksum) VALUES ('9999_from_the_future.sql', 'x')`);
      await client.query(`UPDATE schema_migrations SET checksum = 'tampered' WHERE name = '0001_org_iam.sql'`).catch(() => undefined);
      const v = await verifyDatabase(client);
      expect(v.ok).toBe(false);
      expect(v.checks.find((c) => c.name === 'schema')).toMatchObject({ ok: false, detail: expect.stringContaining('9999_from_the_future.sql') });
    } finally { await client.query('ROLLBACK'); client.release(); }
  });
});
