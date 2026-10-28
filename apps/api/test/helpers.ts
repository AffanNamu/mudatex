import { SignJWT } from 'jose';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { bootstrapOrganization } from '../src/bootstrap.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';

export const SECRET = 'test-secret-test-secret-test-secret-123';

export async function setupApp(env: Record<string, string> = {}, deps: { migrationsDir?: string; payments?: import('../src/payments/paystack.js').PaymentProvider; pusher?: import('../src/notify/push.js').Pusher; mailer?: import('../src/notify/mailer.js').Mailer; carrierAdapters?: import('../src/shipping/adapters.js').AdapterRegistry } = {}) {
  const db = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL, AUTH_DEV_SECRET: SECRET, DEV_TOKEN_ENDPOINT: 'true', ...env });
  const app = await buildServer({ config, db, ...deps });
  return { app, db, close: async () => { await app.close(); await db.end(); } };
}

export async function token(subject: string, opts: { expiresIn?: string; secret?: string; noExpiry?: boolean; noSubject?: boolean; email?: string; aal?: 'aal1' | 'aal2' } = {}) {
  let jwt = new SignJWT({ ...(opts.email ? { email: opts.email } : {}), ...(opts.aal ? { aal: opts.aal } : {}) }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt();
  if (!opts.noSubject) jwt = jwt.setSubject(subject);
  if (!opts.noExpiry) jwt = jwt.setExpirationTime(opts.expiresIn ?? '5m');
  return jwt.sign(new TextEncoder().encode(opts.secret ?? SECRET));
}

export async function newOrg(db: pg.Pool, name = 'Org') {
  const sub = `admin-${crypto.randomUUID()}`;
  const ids = await bootstrapOrganization(db, {
    organizationName: name,
    adminSubject: sub,
    adminEmail: `${sub}@example.test`,
    adminName: 'Admin',
  });
  return { ...ids, sub, auth: { authorization: `Bearer ${await token(sub)}` } };
}

export type Headers = { authorization: string } & Record<string, string>;

export async function call(app: FastifyInstance, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, headers: Headers | undefined, payload?: unknown) {
  const res = await app.inject({ method, url, headers, payload: payload as never });
  return { status: res.statusCode, body: res.body ? (JSON.parse(res.body) as any) : undefined };
}

/** Creates a user, a role and a membership; returns that user's auth header. */
export async function staff(
  app: FastifyInstance,
  admin: Headers,
  permissions: string[],
  scope: Record<string, unknown>,
) {
  const sub = `staff-${crypto.randomUUID()}`;
  const user = await call(app, 'POST', '/v1/users', admin, { externalSubject: sub, email: `${sub}@example.test`, displayName: 'Staff' });
  const role = await call(app, 'POST', '/v1/roles', admin, { key: `r_${crypto.randomUUID().slice(0, 8).replace(/-/g, '')}`, name: 'Role', permissions });
  const grant = await call(app, 'POST', '/v1/memberships', admin, { userId: user.body.id, roleId: role.body.id, scope });
  if (grant.status !== 201) throw new Error(`grant failed: ${JSON.stringify(grant.body)}`);
  return { userId: user.body.id as string, roleId: role.body.id as string, membershipId: grant.body.id as string, auth: { authorization: `Bearer ${await token(sub)}` } };
}
