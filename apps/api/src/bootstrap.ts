import { writeAudit } from './audit.js';
import { withTx, type Db } from './db.js';
import { PERMISSIONS } from './auth/permissions.js';

export interface BootstrapInput {
  organizationName: string;
  adminSubject: string;
  adminEmail: string;
  adminName: string;
}

/**
 * Creates an organization with a group-wide administrator. This is the only
 * path that grants access without an existing administrator, so it is run by
 * operators (CLI) and never exposed over HTTP.
 */
export async function bootstrapOrganization(db: Db, input: BootstrapInput) {
  return withTx(db, async (tx) => {
    const org = await tx.query<{ id: string }>('INSERT INTO organizations (name) VALUES ($1) RETURNING id', [
      input.organizationName,
    ]);
    const organizationId = org.rows[0]!.id;
    const user = await tx.query<{ id: string }>(
      `INSERT INTO users (organization_id, external_subject, email, display_name)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [organizationId, input.adminSubject, input.adminEmail, input.adminName],
    );
    const userId = user.rows[0]!.id;
    const role = await tx.query<{ id: string }>(
      `INSERT INTO roles (organization_id, key, name) VALUES ($1, 'group_admin', 'Group administrator') RETURNING id`,
      [organizationId],
    );
    const roleId = role.rows[0]!.id;
    for (const p of PERMISSIONS) {
      await tx.query('INSERT INTO role_permissions (role_id, permission) VALUES ($1, $2)', [roleId, p]);
    }
    await tx.query(
      `INSERT INTO memberships (organization_id, user_id, role_id, scope_type, scope_id)
       VALUES ($1, $2, $3, 'group', $1)`,
      [organizationId, userId, roleId],
    );
    await writeAudit(tx, {
      organizationId,
      actorUserId: null,
      action: 'organization.bootstrap',
      entityType: 'organization',
      entityId: organizationId,
      after: { name: input.organizationName, adminUserId: userId },
    });
    return { organizationId, userId, roleId };
  });
}
