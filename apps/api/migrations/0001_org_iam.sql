-- Organization hierarchy and scoped IAM.
-- group (organization) -> legal entity -> location tree. Country is an attribute
-- of legal entities and locations, not an interchangeable level.

CREATE TABLE organizations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE legal_entities (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organizations(id),
  name                text NOT NULL,
  country_code        char(2) NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
  functional_currency char(3) NOT NULL CHECK (functional_currency ~ '^[A-Z]{3}$'),
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);

CREATE TYPE location_type AS ENUM ('branch', 'warehouse', 'storage_location', 'department', 'cost_centre');

CREATE TABLE locations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_entity_id  uuid NOT NULL REFERENCES legal_entities(id),
  parent_id        uuid REFERENCES locations(id),
  type             location_type NOT NULL,
  name             text NOT NULL,
  country_code     char(2) NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
  timezone         text NOT NULL,
  -- ids from the root of the location tree down to and including this row.
  ancestor_ids     uuid[] NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (legal_entity_id, name),
  CHECK (ancestor_ids[array_length(ancestor_ids, 1)] = id)
);
CREATE INDEX locations_ancestors_idx ON locations USING gin (ancestor_ids);

-- Staff identity. Credentials live in the external identity provider; we only
-- map its stable subject claim to a user row.
CREATE TYPE user_status AS ENUM ('active', 'suspended');

CREATE TABLE users (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  external_subject text NOT NULL,
  email            text NOT NULL,
  display_name     text NOT NULL,
  status           user_status NOT NULL DEFAULT 'active',
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (external_subject),
  UNIQUE (organization_id, email)
);

CREATE TABLE roles (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  key             text NOT NULL,
  name            text NOT NULL,
  UNIQUE (organization_id, key)
);

CREATE TABLE role_permissions (
  role_id    uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission text NOT NULL,
  PRIMARY KEY (role_id, permission)
);

CREATE TYPE scope_type AS ENUM ('group', 'country', 'legal_entity', 'location');

-- A role granted to a user over one scope. Revocation is a timestamp, never a delete.
CREATE TABLE memberships (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  user_id         uuid NOT NULL REFERENCES users(id),
  role_id         uuid NOT NULL REFERENCES roles(id),
  scope_type      scope_type NOT NULL,
  -- group: organization id; legal_entity: legal entity id; location: location id.
  scope_id        uuid,
  -- country scope: ISO 3166-1 alpha-2 code within the organization.
  scope_country   char(2),
  valid_from      timestamptz NOT NULL DEFAULT now(),
  valid_until     timestamptz,
  revoked_at      timestamptz,
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (scope_type = 'country' AND scope_country IS NOT NULL AND scope_id IS NULL) OR
    (scope_type <> 'country' AND scope_id IS NOT NULL AND scope_country IS NULL)
  )
);
CREATE INDEX memberships_user_idx ON memberships (user_id) WHERE revoked_at IS NULL;
