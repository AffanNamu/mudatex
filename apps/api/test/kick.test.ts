import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { call, newOrg, SECRET } from './helpers.js';

describe('delivery after writes (hosts with no background worker)', () => {
  const db = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  afterAll(() => db.end());
  let calls = 0;
  let slow = false;
  let app: Awaited<ReturnType<typeof buildServer>>;
  beforeAll(async () => {
    const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL, AUTH_DEV_SECRET: SECRET });
    app = await buildServer({ config, db, kick: async () => { calls++; if (slow) await new Promise((r) => setTimeout(r, 10_000)); } });
  });
  afterAll(() => app.close());

  it('runs one delivery pass after a successful write, not after reads or failures', async () => {
    const org = await newOrg(db);
    await call(app, 'GET', '/v1/me', org.auth);
    expect(calls).toBe(0);
    const bad = await call(app, 'POST', '/v1/units', org.auth, { code: '' });
    expect(bad.status).toBe(400);
    expect(calls).toBe(0);
    const ok = await call(app, 'POST', '/v1/units', org.auth, { code: 'kk', name: 'Kick', kind: 'discrete', precision: 0 });
    expect(ok.status).toBe(201);
    expect(calls).toBe(1);
  });

  it('never makes the caller wait more than a few seconds for it', async () => {
    const org = await newOrg(db);
    slow = true;
    const t = Date.now();
    const ok = await call(app, 'POST', '/v1/units', org.auth, { code: 'kk', name: 'Kick', kind: 'discrete', precision: 0 });
    slow = false;
    expect(ok.status).toBe(201);
    expect(Date.now() - t).toBeLessThan(5000);
  }, 15_000);
});
