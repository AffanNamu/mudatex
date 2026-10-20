import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createPool } from '../src/db.js';
import { call, newOrg, setupApp, token } from './helpers.js';

describe('HTTP hardening', () => {
  it('sends security headers and a request id, and ignores malformed client ids', async () => {
    const t = await setupApp();
    try {
      const ok = await t.app.inject({ method: 'GET', url: '/health', headers: { 'x-request-id': 'client-id-12345' } });
      expect(ok.headers['x-content-type-options']).toBe('nosniff');
      expect(ok.headers['x-frame-options']).toBeDefined();
      expect(ok.headers['strict-transport-security']).toBeDefined();
      expect(ok.headers['x-powered-by']).toBeUndefined();
      expect(ok.headers['x-request-id']).toBe('client-id-12345');
      const forged = await t.app.inject({ method: 'GET', url: '/health', headers: { 'x-request-id': 'bad id\nwith newline' } });
      expect(forged.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    } finally { await t.close(); }
  });

  it('allows cross-origin calls only from configured origins', async () => {
    const closed = await setupApp();
    const open = await setupApp({ CORS_ORIGINS: 'https://app.example.com, https://admin.example.com' });
    try {
      const pre = (app: typeof closed.app, origin: string) => app.inject({ method: 'OPTIONS', url: '/v1/me', headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,idempotency-key' } });
      expect((await pre(open.app, 'https://app.example.com')).headers['access-control-allow-origin']).toBe('https://app.example.com');
      expect((await pre(open.app, 'https://admin.example.com')).headers['access-control-allow-origin']).toBe('https://admin.example.com');
      expect((await pre(open.app, 'https://evil.example.com')).headers['access-control-allow-origin']).toBeUndefined();
      // Browsers refuse PUT and DELETE unless the preflight allows them (the default allows only GET, HEAD and POST).
      for (const method of ['PUT', 'DELETE']) {
        const r = await open.app.inject({ method: 'OPTIONS', url: '/v1/me', headers: { origin: 'https://app.example.com', 'access-control-request-method': method } });
        expect(r.headers['access-control-allow-methods']).toContain(method);
      }
      expect((await pre(closed.app, 'https://app.example.com')).headers['access-control-allow-origin']).toBeUndefined();
    } finally { await closed.close(); await open.close(); }
  });

  it('rate limits clients but never the health probes', async () => {
    const t = await setupApp({ RATE_LIMIT_MAX: '5' });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 8; i++) codes.push((await t.app.inject({ method: 'GET', url: '/v1/me' })).statusCode);
      expect(codes.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
      expect(codes.slice(5)).toEqual([429, 429, 429]);
      for (let i = 0; i < 10; i++) expect((await t.app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    } finally { await t.close(); }
  });

  it('rejects oversized request bodies', async () => {
    const t = await setupApp({ BODY_LIMIT_BYTES: '2000' });
    try {
      const org = await newOrg(t.db);
      const big = await t.app.inject({ method: 'POST', url: '/v1/units', headers: org.auth, payload: { code: 'x', name: 'y'.repeat(5000), kind: 'decimal', precision: 2 } });
      expect(big.statusCode).toBe(413);
    } finally { await t.close(); }
  });

  it('answers malformed requests with 4xx, not 500', async () => {
    const t = await setupApp();
    try {
      const org = await newOrg(t.db);
      const badJson = await t.app.inject({ method: 'POST', url: '/v1/units', headers: { ...org.auth, 'content-type': 'application/json' }, payload: '{"code": ' });
      expect(badJson.statusCode).toBe(400);
      const wrongType = await t.app.inject({ method: 'POST', url: '/v1/units', headers: { ...org.auth, 'content-type': 'application/xml' }, payload: '<a/>' });
      expect(wrongType.statusCode).toBe(415);
      expect(JSON.parse(badJson.body)).toEqual({ error: 'bad_request', message: 'Bad request' });
    } finally { await t.close(); }
  });

  it('does not leak internals in error responses', async () => {
    const t = await setupApp();
    try {
      const org = await newOrg(t.db);
      const r = await call(t.app, 'GET', '/v1/products?limit=abc', org.auth);
      expect(r.status).toBe(400);
      expect(JSON.stringify(r.body)).not.toMatch(/node_modules|\.ts:|stack|SELECT /i);
    } finally { await t.close(); }
  });
});

describe('readiness', () => {
  it('is ready when migrations are applied and not ready when one is pending', async () => {
    const t = await setupApp();
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ready-'));
    await writeFile(path.join(dir, '9999_pending.sql'), 'SELECT 1;');
    const behind = await setupApp({}, { migrationsDir: dir });
    try {
      const ok = await t.app.inject({ method: 'GET', url: '/ready' });
      expect(ok.statusCode).toBe(200);
      expect(JSON.parse(ok.body)).toEqual({ ready: true, database: true, pendingMigrations: [] });
      const no = await behind.app.inject({ method: 'GET', url: '/ready' });
      expect(no.statusCode).toBe(503);
      expect(JSON.parse(no.body)).toMatchObject({ ready: false, database: true, pendingMigrations: ['9999_pending.sql'] });
    } finally { await t.close(); await behind.close(); }
  });
});

describe('token validation', () => {
  it('rejects tokens with no expiry or no subject', async () => {
    const t = await setupApp();
    try {
      const org = await newOrg(t.db);
      expect((await call(t.app, 'GET', '/v1/me', org.auth)).status).toBe(200);
      const noExp = await token(org.sub, { noExpiry: true });
      expect((await call(t.app, 'GET', '/v1/me', { authorization: `Bearer ${noExp}` })).status).toBe(401);
      const noSub = await token(org.sub, { noSubject: true });
      expect((await call(t.app, 'GET', '/v1/me', { authorization: `Bearer ${noSub}` })).status).toBe(401);
    } finally { await t.close(); }
  });
});

describe('database limits', () => {
  it('cancels a statement that runs past the timeout', async () => {
    const pool = createPool(process.env.TEST_DATABASE_URL!, { statementTimeoutMs: 150, max: 2 });
    try {
      await expect(pool.query('SELECT pg_sleep(2)')).rejects.toThrow(/statement timeout/);
      expect((await pool.query('SELECT 1 AS ok')).rows[0].ok).toBe(1);
    } finally { await pool.end(); }
  });

  it('closes a transaction left idle', async () => {
    const pool = createPool(process.env.TEST_DATABASE_URL!, { idleInTransactionTimeoutMs: 200, max: 2 });
    try {
      const c = await pool.connect();
      c.on('error', () => {});   // the server terminates this session on purpose
      await c.query('BEGIN');
      await new Promise((r) => setTimeout(r, 600));
      await expect(c.query('SELECT 1')).rejects.toThrow();
      c.release(true);
    } finally { await pool.end(); }
  });
});
