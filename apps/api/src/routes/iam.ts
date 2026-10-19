import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../audit.js';
import { authorize, can, type Target } from '../auth/authorize.js';
import { isPermission } from '../auth/permissions.js';
import { withTx, type Db } from '../db.js';
import { forbidden, invalid, notFound } from '../errors.js';

const userBody = z.object({
  externalSubject: z.string().min(1),
  email: z.string().email(),
  displayName: z.string().min(1),
});

const roleBody = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{1,60}$/),
  name: z.string().min(1),
  permissions: z.array(z.string()).min(1),
});

const scopeBody = z.discriminatedUnion('type', [
  z.object({ type: z.literal('group') }),
  z.object({ type: z.literal('country'), countryCode: z.string().regex(/^[A-Z]{2}$/) }),
  z.object({ type: z.literal('legal_entity'), id: z.string().uuid() }),
  z.object({ type: z.literal('location'), id: z.string().uuid() }),
]);

const membershipBody = z.object({
  userId: z.string().uuid(),
  roleId: z.string().uuid(),
  scope: scopeBody,
  validUntil: z.string().datetime().optional(),
});

function scopeToTarget(scope: z.infer<typeof scopeBody>): Target {
  switch (scope.type) {
    case 'group':
      return { kind: 'organization' };
    case 'country':
      return { kind: 'country', countryCode: scope.countryCode };
    case 'legal_entity':
      return { kind: 'legal_entity', legalEntityId: scope.id };
    case 'location':
      return { kind: 'location', locationId: scope.id };
  }
}

export const iamRoutes: FastifyPluginAsync<{ db: Db }> = async (app, { db }) => {
  app.post('/users', async (req, reply) => {
    const body = userBody.parse(req.body);
    const { actor } = req;
    const created = await withTx(db, async (tx) => {
      await authorize(tx, actor, 'iam.manage', { kind: 'organization' });
      const { rows } = await tx.query(
        `INSERT INTO users (organization_id, external_subject, email, display_name)
         VALUES ($1, $2, $3, $4) RETURNING id, email, display_name AS "displayName", status`,
        [actor.organizationId, body.externalSubject, body.email, body.displayName],
      );
      await writeAudit(tx, {
        organizationId: actor.organizationId,
        actorUserId: actor.userId,
        requestId: req.id,
        action: 'user.create',
        entityType: 'user',
        entityId: rows[0].id,
        after: rows[0],
      });
      return rows[0];
    });
    return reply.status(201).send(created);
  });

  app.post('/users/:id/suspend', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { actor } = req;
    if (id === actor.userId) throw invalid('You cannot suspend yourself');
    return withTx(db, async (tx) => {
      await authorize(tx, actor, 'iam.manage', { kind: 'organization' });
      const { rows } = await tx.query(
        `UPDATE users SET status = 'suspended' WHERE id = $1 AND organization_id = $2
         RETURNING id, email, status`,
        [id, actor.organizationId],
      );
      if (!rows[0]) throw notFound('User');
      await writeAudit(tx, {
        organizationId: actor.organizationId,
        actorUserId: actor.userId,
        requestId: req.id,
        action: 'user.suspend',
        entityType: 'user',
        entityId: id,
      });
      return rows[0];
    });
  });

  app.post('/roles', async (req, reply) => {
    const body = roleBody.parse(req.body);
    const { actor } = req;
    const unknown = body.permissions.filter((p) => !isPermission(p));
    if (unknown.length) throw invalid(`Unknown permissions: ${unknown.join(', ')}`);
    const created = await withTx(db, async (tx) => {
      await authorize(tx, actor, 'iam.manage', { kind: 'organization' });
      const { rows } = await tx.query<{ id: string }>(
        'INSERT INTO roles (organization_id, key, name) VALUES ($1, $2, $3) RETURNING id',
        [actor.organizationId, body.key, body.name],
      );
      const id = rows[0]!.id;
      for (const p of new Set(body.permissions)) {
        await tx.query('INSERT INTO role_permissions (role_id, permission) VALUES ($1, $2)', [id, p]);
      }
      const result = { id, key: body.key, name: body.name, permissions: [...new Set(body.permissions)] };
      await writeAudit(tx, {
        organizationId: actor.organizationId,
        actorUserId: actor.userId,
        requestId: req.id,
        action: 'role.create',
        entityType: 'role',
        entityId: id,
        after: result,
      });
      return result;
    });
    return reply.status(201).send(created);
  });

  app.post('/memberships', async (req, reply) => {
    const body = membershipBody.parse(req.body);
    const { actor } = req;
    const target = scopeToTarget(body.scope);
    const created = await withTx(db, async (tx) => {
      await authorize(tx, actor, 'iam.manage', target);
      if (body.userId === actor.userId) throw forbidden('You cannot grant access to yourself');

      const user = await tx.query('SELECT 1 FROM users WHERE id = $1 AND organization_id = $2', [
        body.userId,
        actor.organizationId,
      ]);
      if (!user.rowCount) throw notFound('User');
      const role = await tx.query<{ permission: string }>(
        `SELECT rp.permission FROM roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id
          WHERE r.id = $1 AND r.organization_id = $2`,
        [body.roleId, actor.organizationId],
      );
      if (!role.rowCount) throw notFound('Role');

      // No privilege escalation: the grantor must hold every permission being granted, over the same scope.
      for (const { permission } of role.rows) {
        if (permission && !(await can(tx, actor, permission as never, target))) {
          throw forbidden(`You do not hold ${permission} over this scope`);
        }
      }

      const { rows } = await tx.query(
        `INSERT INTO memberships (organization_id, user_id, role_id, scope_type, scope_id, scope_country, valid_until, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, user_id AS "userId", role_id AS "roleId", scope_type AS "scopeType", scope_id AS "scopeId",
                   scope_country AS "scopeCountry", valid_until AS "validUntil"`,
        [
          actor.organizationId,
          body.userId,
          body.roleId,
          body.scope.type,
          body.scope.type === 'group' ? actor.organizationId : body.scope.type === 'country' ? null : body.scope.id,
          body.scope.type === 'country' ? body.scope.countryCode : null,
          body.validUntil ?? null,
          actor.userId,
        ],
      );
      await writeAudit(tx, {
        organizationId: actor.organizationId,
        actorUserId: actor.userId,
        requestId: req.id,
        action: 'membership.grant',
        entityType: 'membership',
        entityId: rows[0].id,
        after: rows[0],
      });
      return rows[0];
    });
    return reply.status(201).send(created);
  });

  app.delete('/memberships/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { actor } = req;
    await withTx(db, async (tx) => {
      const { rows } = await tx.query<{
        scope_type: 'group' | 'country' | 'legal_entity' | 'location';
        scope_id: string | null;
        scope_country: string | null;
      }>(
        `SELECT scope_type, scope_id, scope_country FROM memberships
          WHERE id = $1 AND organization_id = $2 AND revoked_at IS NULL FOR UPDATE`,
        [id, actor.organizationId],
      );
      const m = rows[0];
      if (!m) throw notFound('Membership');
      const target: Target =
        m.scope_type === 'group'
          ? { kind: 'organization' }
          : m.scope_type === 'country'
            ? { kind: 'country', countryCode: m.scope_country!.trim() }
            : m.scope_type === 'legal_entity'
              ? { kind: 'legal_entity', legalEntityId: m.scope_id! }
              : { kind: 'location', locationId: m.scope_id! };
      await authorize(tx, actor, 'iam.manage', target);
      await tx.query('UPDATE memberships SET revoked_at = now() WHERE id = $1', [id]);
      await writeAudit(tx, {
        organizationId: actor.organizationId,
        actorUserId: actor.userId,
        requestId: req.id,
        action: 'membership.revoke',
        entityType: 'membership',
        entityId: id,
      });
    });
    return reply.status(204).send();
  });
};
