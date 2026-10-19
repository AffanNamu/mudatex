import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Dispatcher, backoffSeconds, type DomainEvent, type InternalConsumer } from '../src/events/dispatcher.js';
import { purgeDelivered, purgeIdempotencyKeys } from '../src/events/maintenance.js';
import { matchesPattern } from '../src/events/publish.js';
import { createSecretBox } from '../src/events/secretbox.js';
import { sign, verifySignature } from '../src/events/signing.js';
import { isPrivateAddress } from '../src/events/url-safety.js';
import { call, newOrg, setupApp } from './helpers.js';

const KEY = randomBytes(32).toString('base64');
const box = createSecretBox(KEY)!;
const POLICY = { allowHttp: true, allowPrivate: true };

let ctx: Awaited<ReturnType<typeof setupApp>>;
beforeAll(async () => { ctx = await setupApp({ SECRETS_ENCRYPTION_KEY: KEY, WEBHOOK_ALLOW_HTTP: 'true', WEBHOOK_ALLOW_PRIVATE: 'true' }); });
afterAll(async () => { await ctx.close(); });

interface Hit { headers: http.IncomingHttpHeaders; body: string; path: string }
async function receiver(respond: (n: number, req: http.IncomingMessage, res: http.ServerResponse) => void = (_n, _q, res) => res.writeHead(200).end('ok')) {
  const hits: Hit[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => { hits.push({ headers: req.headers, body, path: req.url ?? '' }); respond(hits.length, req, res); });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, hits, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

const dispatcher = (extra: Partial<ConstructorParameters<typeof Dispatcher>[1]> = {}) => new Dispatcher(ctx.db, { secretBox: box, urlPolicy: POLICY, jitter: () => 0.5, ...extra });
async function drain(d: Dispatcher, now = new Date()) {
  for (let i = 0; i < 60; i++) if ((await d.runOnce(now)) === 0) return;
}
async function hook(org: Awaited<ReturnType<typeof newOrg>>, url: string, eventTypes = ['legal_entity.*']) {
  const r = await call(ctx.app, 'POST', '/v1/integrations/webhooks', org.auth, { url, eventTypes });
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  return { id: r.body.id as string, secret: r.body.secret as string };
}
const makeEntity = (org: Awaited<ReturnType<typeof newOrg>>, name = `LE-${crypto.randomUUID().slice(0, 8)}`) =>
  call(ctx.app, 'POST', '/v1/legal-entities', org.auth, { name, countryCode: 'NG', functionalCurrency: 'NGN' });
const deliveries = async (endpointId: string) =>
  (await ctx.db.query('SELECT status, attempts, last_status_code AS code, last_error AS error, next_attempt_at AS next FROM event_deliveries WHERE endpoint_id = $1 ORDER BY created_at, id', [endpointId])).rows;

describe('events are written with the change that caused them', () => {
  it('emits one event per audited command, and none when the command rolls back', async () => {
    const org = await newOrg(ctx.db);
    const a = await makeEntity(org, 'Alpha');
    expect(a.status).toBe(201);
    expect((await makeEntity(org, 'Alpha')).status).toBe(409);               // duplicate: the transaction rolls back
    const feed = await call(ctx.app, 'GET', '/v1/integrations/events?type=legal_entity.create', org.auth);
    expect(feed.body).toHaveLength(1);
    expect(feed.body[0]).toMatchObject({ type: 'legal_entity.create', aggregateType: 'legal_entity', aggregateId: a.body.id, actorUserId: org.userId });
    const later = await call(ctx.app, 'GET', `/v1/integrations/events?afterId=${feed.body[0].id}`, org.auth);
    expect(later.body.every((e: any) => Number(e.id) > Number(feed.body[0].id))).toBe(true);
  });

  it('are append-only apart from the fan-out marker, and carry no business data', async () => {
    const org = await newOrg(ctx.db);
    await makeEntity(org);
    await expect(ctx.db.query("UPDATE domain_events SET event_type = 'x' WHERE organization_id = $1", [org.organizationId])).rejects.toThrow(/append-only/);
    await expect(ctx.db.query('DELETE FROM domain_events WHERE organization_id = $1', [org.organizationId])).rejects.toThrow(/append-only/);
    await expect(ctx.db.query('TRUNCATE domain_events')).rejects.toThrow(/append-only|cannot truncate/);
    await ctx.db.query('UPDATE domain_events SET fanned_out_at = now() WHERE organization_id = $1 AND fanned_out_at IS NULL', [org.organizationId]);
    const ev = await ctx.db.query('SELECT payload FROM domain_events WHERE organization_id = $1', [org.organizationId]);
    expect(ev.rows.every((r) => Object.keys(r.payload).length === 0)).toBe(true);
  });

  it('are isolated per organization', async () => {
    const a = await newOrg(ctx.db);
    const b = await newOrg(ctx.db);
    await makeEntity(a, 'OnlyA');
    const feed = await call(ctx.app, 'GET', '/v1/integrations/events', b.auth);
    expect(feed.body.some((e: any) => e.aggregateType === 'legal_entity')).toBe(false);
  });
});

describe('webhook management', () => {
  it('shows the signing secret once and stores it encrypted', async () => {
    const org = await newOrg(ctx.db);
    const r = await receiver();
    try {
      const w = await hook(org, r.url);
      expect(w.secret).toMatch(/^whsec_/);
      const list = await call(ctx.app, 'GET', '/v1/integrations/webhooks', org.auth);
      expect(JSON.stringify(list.body)).not.toContain(w.secret);
      expect(list.body[0]).toMatchObject({ id: w.id, status: 'active', eventTypes: ['legal_entity.*'] });
      const stored = await ctx.db.query('SELECT secret_encrypted FROM webhook_endpoints WHERE id = $1', [w.id]);
      expect(stored.rows[0].secret_encrypted).not.toContain(w.secret);
      expect(box.decrypt(stored.rows[0].secret_encrypted)).toBe(w.secret);
    } finally { await r.close(); }
  });

  it('validates input, requires an administrator, and needs the server key', async () => {
    const org = await newOrg(ctx.db);
    const post = (body: unknown, auth = org.auth) => call(ctx.app, 'POST', '/v1/integrations/webhooks', auth, body);
    expect((await post({ url: 'not a url', eventTypes: ['*'] })).status).toBe(400);
    expect((await post({ url: 'http://127.0.0.1:9/x', eventTypes: [] })).status).toBe(400);
    expect((await post({ url: 'http://127.0.0.1:9/x', eventTypes: ['Bad Pattern!'] })).status).toBe(400);
    expect((await post({ url: 'http://user:pw@127.0.0.1:9/x', eventTypes: ['*'] })).status).toBe(422);
    const { staff } = await import('./helpers.js');
    const reader = await staff(ctx.app, org.auth, ['audit.read'], { type: 'group' });
    expect((await post({ url: 'http://127.0.0.1:9/x', eventTypes: ['*'] }, reader.auth)).status).toBe(403);
    expect((await call(ctx.app, 'GET', '/v1/integrations/webhooks', reader.auth)).status).toBe(403);

    const strict = await setupApp({ SECRETS_ENCRYPTION_KEY: KEY });             // production-like URL policy
    const noKey = await setupApp();
    try {
      const o = await newOrg(strict.db);
      const bad = (url: string) => call(strict.app, 'POST', '/v1/integrations/webhooks', o.auth, { url, eventTypes: ['*'] });
      expect((await bad('http://example.com/hook')).status).toBe(422);          // plain http
      expect((await bad('https://127.0.0.1/hook')).status).toBe(422);           // loopback
      expect((await bad('https://10.0.0.5/hook')).status).toBe(422);            // private
      expect((await bad('https://169.254.169.254/latest/meta-data')).status).toBe(422);   // cloud metadata
      expect((await bad('https://[::1]/hook')).status).toBe(422);
      const nk = await newOrg(noKey.db);
      expect((await call(noKey.app, 'POST', '/v1/integrations/webhooks', nk.auth, { url: 'https://example.com/h', eventTypes: ['*'] })).status).toBe(503);
    } finally { await strict.close(); await noKey.close(); }
  });
});

describe('delivery', () => {
  it('posts a signed event to matching webhooks only', async () => {
    const org = await newOrg(ctx.db);
    const r = await receiver();
    try {
      const w = await hook(org, r.url, ['legal_entity.*']);
      const entity = await makeEntity(org);
      await call(ctx.app, 'POST', '/v1/units', org.auth, { code: 'm', name: 'Metre', kind: 'decimal', precision: 2 });   // does not match
      await drain(dispatcher());
      expect(r.hits).toHaveLength(1);
      const hit = r.hits[0]!;
      const event = JSON.parse(hit.body);
      expect(event).toMatchObject({ type: 'legal_entity.create', schemaVersion: 1, aggregateType: 'legal_entity', aggregateId: entity.body.id, organizationId: org.organizationId, actorUserId: org.userId, payload: {} });
      expect(hit.headers['mudatex-event-id']).toBe(event.id);
      expect(hit.headers['mudatex-event-type']).toBe('legal_entity.create');
      expect(verifySignature(w.secret, hit.body, String(hit.headers['mudatex-signature']))).toBe(true);
      expect(verifySignature('whsec_wrong', hit.body, String(hit.headers['mudatex-signature']))).toBe(false);
      expect(await deliveries(w.id)).toEqual([expect.objectContaining({ status: 'delivered', attempts: 1, code: 200 })]);
    } finally { await r.close(); }
  });

  it('retries failures with growing delays until the receiver recovers', async () => {
    const org = await newOrg(ctx.db);
    const r = await receiver((n, _q, res) => res.writeHead(n < 3 ? 503 : 200).end());
    try {
      const w = await hook(org, r.url);
      await makeEntity(org);
      const d = dispatcher();
      const t0 = new Date();
      await drain(d, t0);
      expect(r.hits).toHaveLength(1);
      let [row] = await deliveries(w.id);
      expect(row).toMatchObject({ status: 'pending', attempts: 1, code: 503, error: 'HTTP 503' });
      expect(+row.next - +t0).toBeCloseTo(30_000, -3);                          // first retry ~30s
      expect(await d.deliverDue(new Date(+t0 + 10_000))).toBe(0);               // not due yet
      expect(await d.deliverDue(new Date(+t0 + 31_000))).toBe(1);
      [row] = await deliveries(w.id);
      expect(row).toMatchObject({ status: 'pending', attempts: 2 });
      expect(+row.next - (+t0 + 31_000)).toBeCloseTo(60_000, -3);               // then ~60s
      expect(await d.deliverDue(new Date(+t0 + 31_000 + 61_000))).toBe(1);
      expect(await deliveries(w.id)).toEqual([expect.objectContaining({ status: 'delivered', attempts: 3, code: 200, error: null })]);
      expect(r.hits).toHaveLength(3);
      expect(new Set(r.hits.map((h) => h.headers['mudatex-event-id'])).size).toBe(1);   // same event id each time: receivers can dedupe
    } finally { await r.close(); }
  });

  it('dead-letters after the attempt limit and lets an administrator retry', async () => {
    const org = await newOrg(ctx.db);
    let healthy = false;
    const r = await receiver((_n, _q, res) => res.writeHead(healthy ? 200 : 500).end());
    try {
      const w = await hook(org, r.url);
      await makeEntity(org);
      const d = dispatcher({ maxAttempts: 3 });
      let now = new Date();
      await drain(d, now);
      for (let i = 0; i < 2; i++) { now = new Date(+now + 7 * 3600_000); await d.deliverDue(now); }
      expect(await deliveries(w.id)).toEqual([expect.objectContaining({ status: 'dead', attempts: 3, code: 500 })]);
      const hitsBefore = r.hits.length;
      expect(await d.deliverDue(new Date(+now + 100 * 3600_000))).toBe(0);      // dead letters are not retried automatically

      const dead = await call(ctx.app, 'GET', `/v1/integrations/deliveries?status=dead&endpointId=${w.id}`, org.auth);
      expect(dead.body).toHaveLength(1);
      expect(dead.body[0]).toMatchObject({ eventType: 'legal_entity.create', attempts: 3, lastError: 'HTTP 500' });
      healthy = true;
      expect((await call(ctx.app, 'POST', `/v1/integrations/deliveries/${dead.body[0].id}/retry`, org.auth)).status).toBe(200);
      expect((await call(ctx.app, 'POST', `/v1/integrations/deliveries/${dead.body[0].id}/retry`, org.auth)).status).toBe(409);   // no longer dead
      await d.deliverDue(new Date(Date.now() + 1000));
      expect(await deliveries(w.id)).toEqual([expect.objectContaining({ status: 'delivered', attempts: 1 })]);
      expect(r.hits.length).toBe(hitsBefore + 1);
    } finally { await r.close(); }
  });

  it('treats rejections as permanent but rate limits and timeouts as retryable', async () => {
    const org = await newOrg(ctx.db);
    const codes = [400, 429];
    const r = await receiver((n, _q, res) => res.writeHead(codes[n - 1] ?? 200).end());
    try {
      const w = await hook(org, r.url);
      await makeEntity(org);
      await makeEntity(org);
      await drain(dispatcher());
      const rows = await deliveries(w.id);
      expect(rows.map((x) => [x.status, x.code]).sort()).toEqual([['dead', 400], ['pending', 429]].sort());
    } finally { await r.close(); }

    const slow = await receiver(() => { /* never answers */ });
    try {
      const org2 = await newOrg(ctx.db);
      const w2 = await hook(org2, slow.url);
      await makeEntity(org2);
      await drain(dispatcher({ timeoutMs: 200 }));
      expect(await deliveries(w2.id)).toEqual([expect.objectContaining({ status: 'pending', attempts: 1, error: 'network: timeout' })]);
    } finally { await slow.close(); }
  });

  it('does not follow redirects', async () => {
    const org = await newOrg(ctx.db);
    const target = await receiver();
    const r = await receiver((_n, _q, res) => res.writeHead(302, { location: `${target.url}/stolen` }).end());
    try {
      const w = await hook(org, r.url);
      await makeEntity(org);
      await drain(dispatcher());
      expect(target.hits).toHaveLength(0);
      expect(await deliveries(w.id)).toEqual([expect.objectContaining({ status: 'dead', code: 302 })]);
    } finally { await r.close(); await target.close(); }
  });

  it('refuses private targets at delivery time even if the stored URL was once acceptable', async () => {
    const org = await newOrg(ctx.db);
    const r = await receiver();
    try {
      const w = await hook(org, r.url);
      await makeEntity(org);
      const strict = dispatcher({ urlPolicy: { allowHttp: true, allowPrivate: false } });   // what production would enforce
      await drain(strict);
      expect(r.hits).toHaveLength(0);
      const [row] = await deliveries(w.id);
      expect(row.status).toBe('pending');
      expect(row.error).toMatch(/private|internal/);
    } finally { await r.close(); }
  });

  it('holds deliveries for a paused webhook and drops those of a disabled one', async () => {
    const org = await newOrg(ctx.db);
    const r = await receiver();
    try {
      const w = await hook(org, r.url);
      await makeEntity(org);
      const d = dispatcher();
      await d.fanOut();                                                         // delivery exists but has not been sent
      expect((await call(ctx.app, 'POST', `/v1/integrations/webhooks/${w.id}/pause`, org.auth)).body.status).toBe('paused');
      expect((await call(ctx.app, 'POST', `/v1/integrations/webhooks/${w.id}/pause`, org.auth)).status).toBe(409);
      await d.deliverDue(new Date());
      expect(r.hits).toHaveLength(0);
      expect(await deliveries(w.id)).toEqual([expect.objectContaining({ status: 'pending', attempts: 0 })]);   // no attempt spent
      await makeEntity(org);
      await drain(d);
      expect((await deliveries(w.id)).length).toBe(1);                          // paused endpoints get no new deliveries either

      await call(ctx.app, 'POST', `/v1/integrations/webhooks/${w.id}/resume`, org.auth);
      await d.deliverDue(new Date(Date.now() + 10 * 60_000));
      expect(r.hits).toHaveLength(1);

      await call(ctx.app, 'POST', `/v1/integrations/webhooks/${w.id}/disable`, org.auth);
      await makeEntity(org);
      await drain(d);
      expect(r.hits).toHaveLength(1);
    } finally { await r.close(); }
  });

  it('signs with the new secret after rotation, and can send a test event', async () => {
    const org = await newOrg(ctx.db);
    const r = await receiver();
    try {
      const w = await hook(org, r.url, ['webhook.test']);
      const rot = await call(ctx.app, 'POST', `/v1/integrations/webhooks/${w.id}/rotate-secret`, org.auth);
      expect(rot.body.secret).toMatch(/^whsec_/);
      expect(rot.body.secret).not.toBe(w.secret);
      expect((await call(ctx.app, 'POST', `/v1/integrations/webhooks/${w.id}/test`, org.auth)).body.queued).toBe(true);
      await drain(dispatcher());
      const hit = r.hits[0]!;
      expect(JSON.parse(hit.body).type).toBe('webhook.test');
      const sig = String(hit.headers['mudatex-signature']);
      expect(verifySignature(rot.body.secret, hit.body, sig)).toBe(true);
      expect(verifySignature(w.secret, hit.body, sig)).toBe(false);
    } finally { await r.close(); }
  });

  it('attempts each delivery exactly once when two workers run at the same time', async () => {
    const org = await newOrg(ctx.db);
    const r = await receiver();
    try {
      const w = await hook(org, r.url);
      for (let i = 0; i < 12; i++) await makeEntity(org);
      const a = dispatcher();
      const b = dispatcher();
      const now = new Date();
      await a.fanOut(500, now);
      await Promise.all([a.deliverDue(now, 5), b.deliverDue(now, 5), a.deliverDue(now, 5), b.deliverDue(now, 5), a.deliverDue(now, 5)]);
      expect(r.hits).toHaveLength(12);
      expect(new Set(r.hits.map((h) => h.headers['mudatex-event-id'])).size).toBe(12);
      expect((await deliveries(w.id)).every((x) => x.status === 'delivered' && x.attempts === 1)).toBe(true);
      // Fanning out twice never duplicates deliveries.
      await Promise.all([a.fanOut(), b.fanOut()]);
      expect((await deliveries(w.id)).length).toBe(12);
    } finally { await r.close(); }
  });

  it('recovers a delivery whose worker died, but not one still leased', async () => {
    const org = await newOrg(ctx.db);
    const r = await receiver();
    try {
      const w = await hook(org, r.url);
      await makeEntity(org);
      const d = dispatcher();
      await d.fanOut();
      await ctx.db.query(`UPDATE event_deliveries SET status = 'sending', attempts = 1, locked_until = now() + interval '1 minute' WHERE endpoint_id = $1`, [w.id]);
      expect(await d.deliverDue(new Date())).toBe(0);                           // another worker holds it
      expect(await d.deliverDue(new Date(Date.now() + 5 * 60_000))).toBe(1);    // lease expired: the worker is presumed dead
      expect((await deliveries(w.id))[0]).toMatchObject({ status: 'delivered', attempts: 2 });
    } finally { await r.close(); }
  });
});

describe('internal consumers', () => {
  it('receive matching events, are retried on failure, and can dedupe on the event id', async () => {
    const org = await newOrg(ctx.db);
    const seen: DomainEvent[] = [];
    let fail = true;
    const consumer: InternalConsumer = {
      name: `test-consumer-${crypto.randomUUID().slice(0, 6)}`,
      patterns: ['legal_entity.create'],
      handle: async (_db, ev) => { if (fail) { fail = false; throw new Error('boom'); } seen.push(ev); },
    };
    const d = dispatcher({ consumers: [consumer] });
    const entity = await makeEntity(org);
    const t0 = new Date();
    await drain(d, t0);
    const mine = () => ctx.db.query(`SELECT status, attempts, last_error FROM event_deliveries WHERE target_kind = 'internal' AND target_key = $1 AND organization_id = $2`, [consumer.name, org.organizationId]);
    expect((await mine()).rows[0]).toMatchObject({ status: 'pending', attempts: 1 });
    expect((await mine()).rows[0].last_error).toMatch(/boom/);
    await d.deliverDue(new Date(+t0 + 60_000));
    expect((await mine()).rows[0]).toMatchObject({ status: 'delivered', attempts: 2 });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ type: 'legal_entity.create', aggregateId: entity.body.id, organizationId: org.organizationId });
  });
});

describe('maintenance', () => {
  it('purges old idempotency keys and delivered deliveries only', async () => {
    const org = await newOrg(ctx.db);
    const r = await receiver();
    try {
      const w = await hook(org, r.url);
      await makeEntity(org);
      await drain(dispatcher());
      await ctx.db.query(`INSERT INTO idempotency_keys (organization_id, user_id, key, request_hash, created_at) VALUES ($1, $2, 'old-key-purge-1', 'h', now() - interval '10 days'), ($1, $2, 'new-key-purge-1', 'h', now())`, [org.organizationId, org.userId]);
      expect(await purgeIdempotencyKeys(ctx.db, 7)).toBeGreaterThanOrEqual(1);
      const keys = await ctx.db.query(`SELECT key FROM idempotency_keys WHERE organization_id = $1`, [org.organizationId]);
      expect(keys.rows.map((k) => k.key)).toEqual(['new-key-purge-1']);

      await ctx.db.query(`UPDATE event_deliveries SET delivered_at = now() - interval '40 days' WHERE endpoint_id = $1`, [w.id]);
      expect(await purgeDelivered(ctx.db, 30)).toBeGreaterThanOrEqual(1);
      expect(await deliveries(w.id)).toEqual([]);
      const ev = await ctx.db.query('SELECT 1 FROM domain_events WHERE organization_id = $1', [org.organizationId]);
      expect(ev.rowCount).toBeGreaterThan(0);                                   // the events themselves stay
    } finally { await r.close(); }
  });
});

describe('local configuration', () => {
  it('ships a valid development encryption key in docker-compose.yml', async () => {
    const { readFileSync } = await import('node:fs');
    const yml = readFileSync(new URL('../../../docker-compose.yml', import.meta.url), 'utf8');
    const keys = [...yml.matchAll(/SECRETS_ENCRYPTION_KEY:\s*(\S+)/g)].map((m) => m[1]!);
    expect(keys.length).toBeGreaterThanOrEqual(2);
    for (const k of keys) expect(() => createSecretBox(k)).not.toThrow();
  });
});

describe('building blocks', () => {
  it('matches event type patterns', () => {
    expect(matchesPattern('*', 'pos.sale')).toBe(true);
    expect(matchesPattern('pos.*', 'pos.sale')).toBe(true);
    expect(matchesPattern('pos.*', 'pos')).toBe(false);
    expect(matchesPattern('pos.*', 'posx.sale')).toBe(false);
    expect(matchesPattern('pos.sale', 'pos.sale')).toBe(true);
    expect(matchesPattern('pos.sale', 'pos.sale_cancel')).toBe(false);
  });

  it('verifies signatures and rejects tampering, wrong secrets and stale timestamps', () => {
    const body = '{"a":1}';
    const now = 1_700_000_000;
    const header = sign('s3cret', body, now);
    expect(verifySignature('s3cret', body, header, 300, now + 10)).toBe(true);
    expect(verifySignature('s3cret', '{"a":2}', header, 300, now)).toBe(false);
    expect(verifySignature('other', body, header, 300, now)).toBe(false);
    expect(verifySignature('s3cret', body, header, 300, now + 301)).toBe(false);
    expect(verifySignature('s3cret', body, 'garbage', 300, now)).toBe(false);
  });

  it('encrypts secrets with authentication', () => {
    const c = box.encrypt('whsec_abc');
    expect(c).not.toContain('whsec_abc');
    expect(box.encrypt('whsec_abc')).not.toBe(c);                              // fresh nonce each time
    expect(box.decrypt(c)).toBe('whsec_abc');
    const parts = c.split('.');
    expect(() => box.decrypt([parts[0], parts[1], parts[2], Buffer.from('x').toString('base64url')].join('.'))).toThrow();
    expect(() => createSecretBox(randomBytes(32).toString('base64'))!.decrypt(c)).toThrow();
    expect(() => createSecretBox('c2hvcnQ=')).toThrow(/32 bytes/);
    expect(createSecretBox(undefined)).toBeNull();
  });

  it('classifies private and public addresses', () => {
    for (const a of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) expect(isPrivateAddress(a)).toBe(true);
    for (const a of ['8.8.8.8', '172.32.0.1', '1.1.1.1', '2606:4700:4700::1111']) expect(isPrivateAddress(a)).toBe(false);
  });

  it('backs off exponentially with a cap', () => {
    expect([1, 2, 3, 4].map((n) => backoffSeconds(n, 0.5))).toEqual([30, 60, 120, 240]);
    expect(backoffSeconds(30, 0.5)).toBe(6 * 3600);
    expect(backoffSeconds(1, 0)).toBe(24);
    expect(backoffSeconds(1, 1)).toBe(36);
  });
});
