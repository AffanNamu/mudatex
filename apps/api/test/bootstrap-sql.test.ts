import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { PERMISSIONS } from '../src/auth/permissions.js';
import { call, setupApp, token } from './helpers.js';

// The no-install way to create the first administrator (paste into Supabase's SQL editor) must give exactly what the
// command-line bootstrap gives, and must not drift when permissions are added.
const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts/bootstrap.sql');

describe('scripts/bootstrap.sql', () => {
  let ctx: Awaited<ReturnType<typeof setupApp>>;
  afterAll(async () => { await ctx?.close(); });

  it('lists every permission, and only the permissions the API knows', async () => {
    const sql = await readFile(file, 'utf8');
    const listed = [...sql.matchAll(/^\s+'([a-z.]+)',?$/gm)].map((m) => m[1]).sort();
    expect(listed).toEqual([...PERMISSIONS].sort());
  });

  it('creates an administrator who can sign in and holds everything, once', async () => {
    ctx = await setupApp();
    const subject = `sql-admin-${crypto.randomUUID()}`;
    const sql = (await readFile(file, 'utf8'))
      .replace('Textile Org', `SQL Org ${subject}`).replace('PASTE-YOUR-SUPABASE-USER-ID-HERE', subject)
      .replace('you@example.com', `${subject}@example.test`).replace('Your Name', 'Sql Admin');
    const db = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    try {
      const r = await db.query(sql);
      expect(r.rows[0]).toMatchObject({ permissions_granted: String(PERMISSIONS.length), memberships_created: '1' });
      const auth = { authorization: `Bearer ${await token(subject)}` };
      const me = await call(ctx.app, 'GET', '/v1/me/grants', auth);
      expect(me.status).toBe(200);
      expect(Object.keys(me.body.permissions).sort()).toEqual([...PERMISSIONS].sort());
      expect(me.body.user).toMatchObject({ displayName: 'Sql Admin', email: `${subject}@example.test` });
      await expect(db.query(sql)).rejects.toThrow();   // running it again does not create a second copy
    } finally { await db.end(); }
  });
});
