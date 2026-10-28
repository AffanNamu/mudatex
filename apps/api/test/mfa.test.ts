import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, newOrg, setupApp, token } from './helpers.js';

let open: Awaited<ReturnType<typeof setupApp>>;
let strict: Awaited<ReturnType<typeof setupApp>>;
beforeAll(async () => {
  open = await setupApp();
  strict = await setupApp({ STAFF_MFA: 'required' });
});
afterAll(async () => { await open.close(); await strict.close(); });

describe('second factor for staff', () => {
  it('does nothing unless the deployment asks for it', async () => {
    const org = await newOrg(open.db);
    expect((await call(open.app, 'GET', '/v1/me', org.auth)).status).toBe(200);
    const g = await call(open.app, 'GET', '/v1/me/grants', org.auth);
    expect(g.status).toBe(200);
    expect(g.body.mfaRequired).toBeUndefined();
    expect(Object.keys(g.body.permissions).length).toBeGreaterThan(0);
  });

  it('lets a first-factor sign-in learn that it needs a second factor, and nothing else', async () => {
    const org = await newOrg(strict.db);
    for (const aal of [undefined, 'aal1'] as const) {
      const auth = { authorization: `Bearer ${await token(org.sub, { aal })}` };
      const g = await call(strict.app, 'GET', '/v1/me/grants', auth);
      expect(g.status).toBe(200);
      expect(g.body).toMatchObject({ mfaRequired: true, permissions: {}, user: { id: expect.any(String) } });
      for (const url of ['/v1/me', '/v1/users', '/v1/roles', '/v1/sales-orders']) {
        const r = await call(strict.app, 'GET', url, auth);
        expect(r.status, url).toBe(403);
        expect(r.body.error).toBe('mfa_required');
      }
      expect((await call(strict.app, 'POST', '/v1/users', auth, { externalSubject: 'x', email: 'x@example.test', displayName: 'X' })).status).toBe(403);
    }
  });

  it('works normally once the second factor is verified (aal2)', async () => {
    const org = await newOrg(strict.db);
    const auth = { authorization: `Bearer ${await token(org.sub, { aal: 'aal2' })}` };
    expect((await call(strict.app, 'GET', '/v1/me', auth)).status).toBe(200);
    const g = await call(strict.app, 'GET', '/v1/me/grants', auth);
    expect(g.body.mfaRequired).toBeUndefined();
    expect(Object.keys(g.body.permissions).length).toBeGreaterThan(0);
    expect((await call(strict.app, 'GET', '/v1/users', auth)).status).toBe(200);
  });

  it('does not stand between shoppers and the shop', async () => {
    expect((await call(strict.app, 'GET', '/shop/nowhere/products', undefined as never)).status).not.toBe(403);
  });

  it('cannot be satisfied by a development token in the browser console', async () => {
    const org = await newOrg(strict.db);
    const dev = await call(strict.app, 'POST', '/v1/dev/token', undefined as never, { email: `${org.sub}@example.test` });
    expect(dev.status).toBe(200);
    expect((await call(strict.app, 'GET', '/v1/me', { authorization: `Bearer ${dev.body.token}` })).status).toBe(200);
  });
});
