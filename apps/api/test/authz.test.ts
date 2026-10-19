import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, newOrg, setupApp, staff, token } from './helpers.js';

let ctx: Awaited<ReturnType<typeof setupApp>>;
beforeAll(async () => { ctx = await setupApp(); });
afterAll(async () => { await ctx.close(); });

async function twoEntities() {
  const org = await newOrg(ctx.db);
  const ng = await call(ctx.app, 'POST', '/v1/legal-entities', org.auth, { name: 'Mudatex NG', countryCode: 'NG', functionalCurrency: 'NGN' });
  const gh = await call(ctx.app, 'POST', '/v1/legal-entities', org.auth, { name: 'Mudatex GH', countryCode: 'GH', functionalCurrency: 'GHS' });
  expect(ng.status).toBe(201);
  const hq = await call(ctx.app, 'POST', '/v1/locations', org.auth, { legalEntityId: ng.body.id, type: 'warehouse', name: 'Lagos DC', countryCode: 'NG', timezone: 'Africa/Lagos' });
  const bin = await call(ctx.app, 'POST', '/v1/locations', org.auth, { legalEntityId: ng.body.id, parentId: hq.body.id, type: 'storage_location', name: 'Lagos DC Bin A', countryCode: 'NG', timezone: 'Africa/Lagos' });
  const shop = await call(ctx.app, 'POST', '/v1/locations', org.auth, { legalEntityId: ng.body.id, type: 'branch', name: 'Ikeja Shop', countryCode: 'NG', timezone: 'Africa/Lagos' });
  return { org, ng: ng.body, gh: gh.body, hq: hq.body, bin: bin.body, shop: shop.body };
}

describe('authentication', () => {
  it('rejects missing, malformed, wrongly signed and expired tokens', async () => {
    expect((await call(ctx.app, 'GET', '/v1/me', undefined)).status).toBe(401);
    expect((await call(ctx.app, 'GET', '/v1/me', { authorization: 'Bearer nope' })).status).toBe(401);
    const wrongKey = await token('x', { secret: 'a-different-secret-a-different-secret-1' });
    expect((await call(ctx.app, 'GET', '/v1/me', { authorization: `Bearer ${wrongKey}` })).status).toBe(401);
    const expired = await token('x', { expiresIn: '-1m' });
    expect((await call(ctx.app, 'GET', '/v1/me', { authorization: `Bearer ${expired}` })).status).toBe(401);
  });

  it('rejects a valid token for an unknown user', async () => {
    const t = await token('nobody');
    expect((await call(ctx.app, 'GET', '/v1/me', { authorization: `Bearer ${t}` })).status).toBe(401);
  });

  it('blocks a suspended user immediately', async () => {
    const { org } = await twoEntities();
    const s = await staff(ctx.app, org.auth, ['org.read'], { type: 'group' });
    expect((await call(ctx.app, 'GET', '/v1/me', s.auth)).status).toBe(200);
    expect((await call(ctx.app, 'POST', `/v1/users/${s.userId}/suspend`, org.auth)).status).toBe(200);
    expect((await call(ctx.app, 'GET', '/v1/me', s.auth)).status).toBe(403);
  });
});

describe('scoped authorization', () => {
  it('lets a legal-entity manager act only inside that entity', async () => {
    const { org, ng, gh } = await twoEntities();
    const mgr = await staff(ctx.app, org.auth, ['org.manage', 'org.read'], { type: 'legal_entity', id: ng.id });

    const ok = await call(ctx.app, 'POST', '/v1/locations', mgr.auth, { legalEntityId: ng.id, type: 'branch', name: 'Abuja', countryCode: 'NG', timezone: 'Africa/Lagos' });
    expect(ok.status).toBe(201);
    const other = await call(ctx.app, 'POST', '/v1/locations', mgr.auth, { legalEntityId: gh.id, type: 'branch', name: 'Accra', countryCode: 'GH', timezone: 'Africa/Accra' });
    expect(other.status).toBe(403);
    // Cannot create legal entities: that needs a group-scope grant.
    const le = await call(ctx.app, 'POST', '/v1/legal-entities', mgr.auth, { name: 'New', countryCode: 'KE', functionalCurrency: 'KES' });
    expect(le.status).toBe(403);
  });

  it('filters list results to the caller scope', async () => {
    const { org, ng, gh, shop } = await twoEntities();
    const ngMgr = await staff(ctx.app, org.auth, ['org.read'], { type: 'legal_entity', id: ng.id });
    const ghCountry = await staff(ctx.app, org.auth, ['org.read'], { type: 'country', countryCode: 'GH' });
    const shopOnly = await staff(ctx.app, org.auth, ['org.read'], { type: 'location', id: shop.id });

    const idsOf = async (auth: any, path: string) => (await call(ctx.app, 'GET', path, auth)).body.map((r: any) => r.id);
    expect(await idsOf(ngMgr.auth, '/v1/legal-entities')).toEqual([ng.id]);
    expect(await idsOf(ghCountry.auth, '/v1/legal-entities')).toEqual([gh.id]);
    expect(await idsOf(ghCountry.auth, '/v1/locations')).toEqual([]);
    expect(await idsOf(shopOnly.auth, '/v1/locations')).toEqual([shop.id]);
    expect(await idsOf(org.auth, '/v1/legal-entities')).toHaveLength(2);
  });

  it('applies a location grant to its descendants but not to siblings', async () => {
    const { org, hq, bin, shop } = await twoEntities();
    const dcManager = await staff(ctx.app, org.auth, ['org.read'], { type: 'location', id: hq.id });
    const ids = (await call(ctx.app, 'GET', '/v1/locations', dcManager.auth)).body.map((l: any) => l.id).sort();
    expect(ids).toEqual([hq.id, bin.id].sort());
    expect(ids).not.toContain(shop.id);
  });

  it('never leaks data across organizations', async () => {
    const a = await twoEntities();
    const b = await newOrg(ctx.db, 'Other Org');
    // Org B admin cannot see or touch org A resources.
    expect((await call(ctx.app, 'GET', '/v1/legal-entities', b.auth)).body).toEqual([]);
    const cross = await call(ctx.app, 'POST', '/v1/locations', b.auth, { legalEntityId: a.ng.id, type: 'branch', name: 'Evil', countryCode: 'NG', timezone: 'Africa/Lagos' });
    expect(cross.status).toBe(404);
    // Cannot grant org A role to org B user either.
    const role = await call(ctx.app, 'POST', '/v1/roles', a.org.auth, { key: 'x1', name: 'X', permissions: ['org.read'] });
    const user = await call(ctx.app, 'POST', '/v1/users', b.auth, { externalSubject: `s-${crypto.randomUUID()}`, email: 'u@example.test', displayName: 'U' });
    const grant = await call(ctx.app, 'POST', '/v1/memberships', b.auth, { userId: user.body.id, roleId: role.body.id, scope: { type: 'group' } });
    expect(grant.status).toBe(404);
  });

  it('stops working once a membership is revoked or expired', async () => {
    const { org, ng } = await twoEntities();
    const s = await staff(ctx.app, org.auth, ['org.read'], { type: 'legal_entity', id: ng.id });
    expect((await call(ctx.app, 'GET', '/v1/legal-entities', s.auth)).body).toHaveLength(1);
    expect((await call(ctx.app, 'DELETE', `/v1/memberships/${s.membershipId}`, org.auth)).status).toBe(204);
    expect((await call(ctx.app, 'GET', '/v1/legal-entities', s.auth)).body).toEqual([]);

    const s2 = await staff(ctx.app, org.auth, ['org.read'], { type: 'legal_entity', id: ng.id });
    await ctx.db.query("UPDATE memberships SET valid_until = now() - interval '1 minute' WHERE id = $1", [s2.membershipId]);
    expect((await call(ctx.app, 'GET', '/v1/legal-entities', s2.auth)).body).toEqual([]);
  });
});

describe('privilege escalation controls', () => {
  it('prevents granting access to yourself', async () => {
    const { org } = await twoEntities();
    const role = await call(ctx.app, 'POST', '/v1/roles', org.auth, { key: 'self', name: 'Self', permissions: ['org.read'] });
    const res = await call(ctx.app, 'POST', '/v1/memberships', org.auth, { userId: org.userId, roleId: role.body.id, scope: { type: 'group' } });
    expect(res.status).toBe(403);
  });

  it('prevents granting permissions the grantor does not hold', async () => {
    const { org, ng } = await twoEntities();
    // iam.manage + org.read over NG, but not catalog.write.
    const delegate = await staff(ctx.app, org.auth, ['iam.manage', 'org.read'], { type: 'legal_entity', id: ng.id });
    const victim = await call(ctx.app, 'POST', '/v1/users', org.auth, { externalSubject: `v-${crypto.randomUUID()}`, email: 'v@example.test', displayName: 'V' });
    const strong = await call(ctx.app, 'POST', '/v1/roles', org.auth, { key: 'strong', name: 'Strong', permissions: ['org.read', 'catalog.write'] });
    const weak = await call(ctx.app, 'POST', '/v1/roles', org.auth, { key: 'weak', name: 'Weak', permissions: ['org.read'] });

    const bad = await call(ctx.app, 'POST', '/v1/memberships', delegate.auth, { userId: victim.body.id, roleId: strong.body.id, scope: { type: 'legal_entity', id: ng.id } });
    expect(bad.status).toBe(403);
    const good = await call(ctx.app, 'POST', '/v1/memberships', delegate.auth, { userId: victim.body.id, roleId: weak.body.id, scope: { type: 'legal_entity', id: ng.id } });
    expect(good.status).toBe(201);
    // Delegate cannot grant at group scope either.
    const wide = await call(ctx.app, 'POST', '/v1/memberships', delegate.auth, { userId: victim.body.id, roleId: weak.body.id, scope: { type: 'group' } });
    expect(wide.status).toBe(403);
  });

  it('rejects unknown permissions in roles', async () => {
    const { org } = await twoEntities();
    const res = await call(ctx.app, 'POST', '/v1/roles', org.auth, { key: 'bogus', name: 'Bogus', permissions: ['everything'] });
    expect(res.status).toBe(422);
  });
});

describe('audit log', () => {
  it('records changes with the actor and cannot be modified', async () => {
    const { org, ng } = await twoEntities();
    const log = await call(ctx.app, 'GET', `/v1/audit-log?entityType=legal_entity&entityId=${ng.id}`, org.auth);
    expect(log.status).toBe(200);
    expect(log.body[0]).toMatchObject({ action: 'legal_entity.create', actorUserId: org.userId });

    await expect(ctx.db.query('UPDATE audit_log SET action = $1', ['tampered'])).rejects.toThrow(/append-only/);
    await expect(ctx.db.query('DELETE FROM audit_log')).rejects.toThrow(/append-only/);
    await expect(ctx.db.query('TRUNCATE audit_log')).rejects.toThrow(/append-only/);
  });

  it('is readable only with audit.read', async () => {
    const { org } = await twoEntities();
    const s = await staff(ctx.app, org.auth, ['org.read'], { type: 'group' });
    expect((await call(ctx.app, 'GET', '/v1/audit-log', s.auth)).status).toBe(403);
  });

  it('does not keep a change whose transaction rolled back', async () => {
    const { org } = await twoEntities();
    const before = (await call(ctx.app, 'GET', '/v1/audit-log?limit=500', org.auth)).body.length;
    // Duplicate name violates a unique constraint after authorization succeeds.
    await call(ctx.app, 'POST', '/v1/legal-entities', org.auth, { name: 'Dup', countryCode: 'NG', functionalCurrency: 'NGN' });
    const dup = await call(ctx.app, 'POST', '/v1/legal-entities', org.auth, { name: 'Dup', countryCode: 'NG', functionalCurrency: 'NGN' });
    expect(dup.status).toBe(409);
    const after = (await call(ctx.app, 'GET', '/v1/audit-log?limit=500', org.auth)).body.length;
    expect(after - before).toBe(1);
  });
});
