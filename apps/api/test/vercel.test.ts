import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHandler } from '../src/vercel.js';
import { SECRET, newOrg } from './helpers.js';
import pg from 'pg';

// The serverless entry point, exercised through a plain Node HTTP server the way a function host drives it.
const env = { NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL!, AUTH_DEV_SECRET: SECRET, DEV_TOKEN_ENDPOINT: 'true', CRON_SECRET: 'cron-secret-for-tests' };
let server: Server;
let base: string;
let db: pg.Pool;
let broken: Server;
let brokenBase: string;

const listen = async (handler: ReturnType<typeof createHandler>) => {
  const s = createServer((req, res) => void handler(req, res));
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return { s, url: `http://127.0.0.1:${(s.address() as AddressInfo).port}` };
};

beforeAll(async () => {
  db = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  ({ s: server, url: base } = await listen(createHandler(env)));
  ({ s: broken, url: brokenBase } = await listen(createHandler({ NODE_ENV: 'production' })));
});
afterAll(async () => {
  server.close(); broken.close();
  await db.end();
});

describe('serverless entry point', () => {
  it('answers probes and reads request bodies', async () => {
    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect(await (await fetch(`${base}/ready`)).json()).toMatchObject({ ready: true, database: true });
    const org = await newOrg(db, 'Fn Org');
    const email = `${org.sub}@example.test`;
    const res = await fetch(`${base}/v1/dev/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) });
    expect(res.status).toBe(200);
    const { token } = (await res.json()) as { token: string };
    const me = await fetch(`${base}/v1/me`, { headers: { authorization: `Bearer ${token}` } });
    expect(await me.json()).toMatchObject({ organizationId: org.organizationId });
    // A JSON command with a body and an idempotency key goes all the way through.
    const unit = await fetch(`${base}/v1/units`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ code: 'm', name: 'Metre', kind: 'decimal', precision: 2 }) });
    expect(unit.status).toBe(201);
    expect(await unit.json()).toMatchObject({ code: 'm' });
  });

  it('runs a delivery pass only for the scheduler that holds the secret', async () => {
    expect((await fetch(`${base}/internal/cron/worker`)).status).toBe(401);
    expect((await fetch(`${base}/internal/cron/worker`, { headers: { authorization: 'Bearer wrong-secret-of-same-len' } })).status).toBe(401);
    const ok = await fetch(`${base}/internal/cron/worker`, { headers: { authorization: `Bearer ${env.CRON_SECRET}` } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, passes: expect.any(Number), handled: expect.any(Number) });
  });

  it('has no scheduler route when no secret is configured', async () => {
    const { s, url } = await listen(createHandler({ ...env, CRON_SECRET: undefined }));
    try { expect((await fetch(`${url}/internal/cron/worker`, { headers: { authorization: 'Bearer anything' } })).status).toBe(404); }
    finally { s.close(); }
  });

  it('says plainly that it is misconfigured instead of crashing, and keeps retrying', async () => {
    const first = await fetch(`${brokenBase}/health`);
    expect(first.status).toBe(503);
    expect(await first.json()).toMatchObject({ error: 'unavailable' });
    expect((await fetch(`${brokenBase}/health`)).status).toBe(503);   // a later request tries again rather than caching the failure
  });
});
