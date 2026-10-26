-- Customer-facing commerce, part 4: enquiries from the public site (contact, wholesale, made-to-order, careers).
-- Anyone can send one; only staff with the permission can read or work them.

CREATE TABLE enquiries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  storefront_id   uuid NOT NULL REFERENCES storefronts(id),
  kind            text NOT NULL CHECK (kind IN ('contact', 'wholesale', 'custom_order', 'careers')),
  name            text NOT NULL,
  email           text,
  phone           text,
  company         text,
  message         text NOT NULL,
  status          text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'in_progress', 'closed')),
  note            text,
  handled_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (email IS NOT NULL OR phone IS NOT NULL)
);
CREATE INDEX enquiries_inbox ON enquiries (organization_id, status, created_at DESC);

INSERT INTO role_permissions (role_id, permission)
SELECT id, 'enquiries.manage' FROM roles WHERE key = 'group_admin'
ON CONFLICT DO NOTHING;
