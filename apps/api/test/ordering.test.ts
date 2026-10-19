import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, newOrg, setupApp } from './helpers.js';
import { buildWorld, cmd, receive } from './inventory-helpers.js';
import { buildPosWorld, card, cash, openSession, sell } from './pos-helpers.js';

let ctx: Awaited<ReturnType<typeof setupApp>>;
beforeAll(async () => { ctx = await setupApp(); });
afterAll(async () => { await ctx.close(); });

// Child rows written in one transaction must be read back in the order the client sent them.
describe('line order', () => {
  it('is preserved for transfer lines, adjustment lines and POS payments', async () => {
    const w = await buildPosWorld(ctx.app, await buildWorld(ctx.app, await newOrg(ctx.db)));
    const a = w.org.auth;
    await receive(ctx.app, a, w.w1, w.inclusive.variantId, '50');
    await receive(ctx.app, a, w.w1, w.fabric.variantId, '50');
    const variants = [w.fabric.variantId, w.inclusive.variantId];

    for (let round = 0; round < 8; round++) {
      const order = round % 2 ? variants : [...variants].reverse();
      const t = await cmd(ctx.app, a, '/v1/inventory/transfers', { sourceLocationId: w.w1, destinationLocationId: w.w2, lines: order.map((variantId) => ({ variantId, quantity: '1' })) });
      expect(t.body.lines.map((l: any) => l.variantId)).toEqual(order);
      const read = await call(ctx.app, 'GET', `/v1/inventory/transfers/${t.body.id}`, a);
      expect(read.body.lines.map((l: any) => l.variantId)).toEqual(order);

      const adj = await cmd(ctx.app, a, '/v1/inventory/adjustments', { locationId: w.w1, reason: 'Cycle count result', lines: order.map((variantId) => ({ variantId, direction: 'decrease', quantity: '1' })) });
      expect(adj.body.lines.map((l: any) => l.variantId)).toEqual(order);
    }

    await openSession(ctx.app, w.cashier.auth, w.reg1);
    for (let round = 0; round < 8; round++) {
      const methods = round % 2 ? ['cash', 'card', 'card'] : ['card', 'cash', 'card'];
      const amounts = [100000, 150000, 126304];
      const payments = methods.map((m, i) => (m === 'cash' ? cash(amounts[i]!) : card(amounts[i]!, `REF-${round}-${i}`)));
      const s = await sell(ctx.app, w.cashier.auth, w.reg1, [{ variantId: w.fabric.variantId, quantity: '1' }], payments);
      expect(s.status).toBe(201);
      expect(s.body.payments.map((p: any) => p.amountMinor)).toEqual(amounts);
      expect(s.body.payments.map((p: any) => p.method)).toEqual(methods);
    }
  });
});
