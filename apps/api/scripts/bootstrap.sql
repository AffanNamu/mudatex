-- Creates your organization and its first administrator. Run it ONCE, in the Supabase SQL Editor, after the API's
-- first deployment has applied the database migrations. Edit only the four values in the first block.
--
-- 'subject' is your Supabase user id (Authentication, Users, the UID column). 'email' is the email you sign in with.
-- Running it twice fails safely (the same user cannot be created twice).
WITH params AS (
  SELECT
    'Textile Org'::text                      AS org_name,
    'PASTE-YOUR-SUPABASE-USER-ID-HERE'::text AS subject,
    'you@example.com'::text                  AS email,
    'Your Name'::text                        AS display_name
),
org AS (
  INSERT INTO organizations (name) SELECT org_name FROM params RETURNING id
),
usr AS (
  INSERT INTO users (organization_id, external_subject, email, display_name)
  SELECT org.id, p.subject, p.email, p.display_name FROM org, params p
  RETURNING id, organization_id
),
adminrole AS (
  INSERT INTO roles (organization_id, key, name)
  SELECT organization_id, 'group_admin', 'Group administrator' FROM usr
  RETURNING id, organization_id
),
perms AS (
  INSERT INTO role_permissions (role_id, permission)
  SELECT adminrole.id, p FROM adminrole, unnest(ARRAY[
      'org.read',
      'org.manage',
      'iam.manage',
      'catalog.read',
      'catalog.write',
      'audit.read',
      'inventory.read',
      'inventory.receive',
      'inventory.issue',
      'inventory.transfer',
      'inventory.reserve',
      'inventory.split',
      'inventory.adjust',
      'inventory.adjust.approve',
      'pricing.manage',
      'pos.register.manage',
      'pos.session',
      'pos.sell',
      'pos.discount',
      'pos.discount.override',
      'pos.payment.verify',
      'pos.refund',
      'pos.refund.approve',
      'pos.read',
      'procurement.read',
      'procurement.supplier.manage',
      'procurement.create',
      'procurement.approve',
      'procurement.receive',
      'procurement.return',
      'accounting.read',
      'accounting.manage',
      'accounting.journal',
      'accounting.post',
      'accounting.period.close',
      'accounting.period.reopen',
      'accounting.rates.manage',
      'accounting.rates.approve',
      'manufacturing.read',
      'manufacturing.workcentre.manage',
      'manufacturing.bom.manage',
      'manufacturing.bom.approve',
      'manufacturing.plan',
      'manufacturing.issue',
      'manufacturing.issue.exception',
      'manufacturing.operate',
      'manufacturing.close',
      'quality.hold',
      'quality.release',
      'integrations.manage',
      'storefront.manage',
      'orders.read',
      'orders.fulfil',
      'orders.payment.record',
      'orders.cancel',
      'enquiries.manage',
      'reviews.moderate'
  ]) AS p
  RETURNING 1
),
membership AS (
  INSERT INTO memberships (organization_id, user_id, role_id, scope_type, scope_id)
  SELECT usr.organization_id, usr.id, adminrole.id, 'group', usr.organization_id FROM usr, adminrole
  RETURNING 1
),
audit AS (
  INSERT INTO audit_log (organization_id, actor_user_id, action, entity_type, entity_id, after_state)
  SELECT usr.organization_id, NULL, 'organization.bootstrap', 'organization', usr.organization_id::text,
         jsonb_build_object('adminUserId', usr.id, 'via', 'sql')
  FROM usr
  RETURNING 1
)
SELECT (SELECT count(*) FROM perms) AS permissions_granted, (SELECT count(*) FROM membership) AS memberships_created;
