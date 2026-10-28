// A stand-in for the parts of Supabase Auth the console uses, so sign-in can be tested without a real project.
// It signs tokens with the same development secret the test API trusts. Never used outside tests.
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';

const SECRET = process.env.AUTH_DEV_SECRET;
const KEY = 'e2e-publishable-key';
const PASSWORD = 'correct-horse-battery';
const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
const stats = { passwordLogins: 0, refreshes: 0, logouts: 0, passwordChanges: 0 };
const revoked = new Set();
let counter = 0;

function token(email, ttl, aal = 'aal1') {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({ sub: email, email, iat: now, exp: now + ttl, aud: 'authenticated', aal });
  return `${head}.${body}.${createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url')}`;
}
// One test user gets a very short session so refreshing can be observed.
const ttlFor = (email) => (email.startsWith('receiver@') ? 6 : 3600);
// Authenticator apps: planner@ already has one; others can add one. The code in this stand-in is always 123456.
const factors = new Map([['planner@e2e.test', [{ id: 'f-planner', factor_type: 'totp', status: 'verified', friendly_name: 'Phone' }]]]);
const emailOf = (req) => { try { return JSON.parse(Buffer.from(String(req.headers.authorization).split('.')[1], 'base64url').toString()).email; } catch { return undefined; } };
const session = (email, aal = 'aal1') => {
  const refresh = `r-${email}-${++counter}`;
  return { access_token: token(email, ttlFor(email), aal), refresh_token: refresh, expires_in: ttlFor(email), token_type: 'bearer' };
};

createServer(async (req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type, apikey, authorization');
  res.setHeader('access-control-allow-methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.writeHead(204).end();
  const url = new URL(req.url, 'http://x');
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
  const send = (status, o) => res.writeHead(status, { 'content-type': 'application/json' }).end(o === undefined ? undefined : JSON.stringify(o));

  if (url.pathname === '/__stats') return send(200, stats);
  if (url.pathname === '/__revoke') { revoked.add(url.searchParams.get('prefix')); return send(204); }
  if (req.headers.apikey !== KEY) return send(401, { message: 'No API key found in request' });

  if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'password') {
    stats.passwordLogins++;
    if (body.password !== PASSWORD) return send(400, { error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
    if (body.email === 'unconfirmed@e2e.test') return send(400, { error_code: 'email_not_confirmed', msg: 'Email not confirmed' });
    return send(200, session(body.email));
  }
  if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'refresh_token') {
    stats.refreshes++;
    const m = /^r-(.+)-\d+$/.exec(body.refresh_token ?? '');
    if (!m || [...revoked].some((p) => m[1].startsWith(p))) return send(400, { error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token' });
    return send(200, session(m[1]));
  }
  if (url.pathname === '/auth/v1/signup') {
    stats.signups = (stats.signups ?? 0) + 1;
    if (String(body.password ?? '').length < 8) return send(422, { msg: 'Password should be at least 8 characters.' });
    if (body.email === 'taken@e2e.test') return send(422, { msg: 'User already registered' });
    // Addresses starting "confirm-" model a project that requires email confirmation: no session yet.
    if (String(body.email).startsWith('confirm-')) return send(200, { id: 'u-' + body.email, email: body.email });
    return send(200, session(body.email));
  }
  if (url.pathname === '/auth/v1/logout') { stats.logouts++; return send(204); }
  if (url.pathname === '/auth/v1/recover') return send(200, {});
  if (url.pathname === '/auth/v1/user' && req.method === 'GET') return send(200, { email: emailOf(req), factors: factors.get(emailOf(req)) ?? [] });
  if (url.pathname === '/auth/v1/factors' && req.method === 'POST') {
    const email = emailOf(req);
    const f = { id: `f-${++counter}`, factor_type: 'totp', status: 'unverified', friendly_name: body.friendly_name };
    factors.set(email, [...(factors.get(email) ?? []), f]);
    return send(200, { id: f.id, type: 'totp', totp: { qr_code: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>', secret: 'JBSWY3DPEHPK3PXP' } });
  }
  const fm = /^\/auth\/v1\/factors\/([^/]+)\/(challenge|verify)$/.exec(url.pathname);
  if (fm && req.method === 'POST') {
    if (fm[2] === 'challenge') { stats.challenges = (stats.challenges ?? 0) + 1; return send(200, { id: 'ch-1' }); }
    if (body.code !== '123456') return send(400, { error_code: 'mfa_verification_failed', msg: 'Invalid TOTP code' });
    const email = emailOf(req);
    for (const f of factors.get(email) ?? []) if (f.id === fm[1]) f.status = 'verified';
    return send(200, session(email, 'aal2'));
  }
  const fd = /^\/auth\/v1\/factors\/([^/]+)$/.exec(url.pathname);
  if (fd && req.method === 'DELETE') { const email = emailOf(req); factors.set(email, (factors.get(email) ?? []).filter((f) => f.id !== fd[1])); return send(200, {}); }
  if (url.pathname === '/auth/v1/user' && req.method === 'PUT') {
    if (req.headers.authorization !== 'Bearer valid-link-token') return send(401, { msg: 'invalid JWT' });
    if (String(body.password).length < 10) return send(422, { msg: 'Password should be at least 10 characters.' });
    stats.passwordChanges++;
    return send(200, {});
  }
  send(404, { msg: 'not found' });
}).listen(3200, () => console.log('mock supabase on 3200'));
