-- Product catalogue with explicit units and conversions.
-- The catalogue is shared across the organization; reads and writes are
-- authorized with organization-level permissions.

CREATE TYPE unit_kind AS ENUM ('discrete', 'decimal');

CREATE TABLE units (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  code            text NOT NULL,          -- e.g. m, yd, roll, pcs, kg
  name            text NOT NULL,
  kind            unit_kind NOT NULL,
  -- digits allowed after the decimal point; must be 0 for discrete units.
  precision       smallint NOT NULL CHECK (precision BETWEEN 0 AND 6),
  UNIQUE (organization_id, code),
  CHECK (kind = 'decimal' OR precision = 0)
);

CREATE TYPE record_status AS ENUM ('active', 'archived');

CREATE TABLE products (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  name            text NOT NULL,
  description     text,
  category        text,
  base_unit_id    uuid NOT NULL REFERENCES units(id),
  -- configurable textile attributes (fabric family, composition, width ...)
  attributes      jsonb NOT NULL DEFAULT '{}'::jsonb,
  status          record_status NOT NULL DEFAULT 'active',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE product_variants (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  product_id      uuid NOT NULL REFERENCES products(id),
  sku             text NOT NULL,
  attributes      jsonb NOT NULL DEFAULT '{}'::jsonb,   -- colour, width, design code
  status          record_status NOT NULL DEFAULT 'active',
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, sku)
);

-- Barcodes are unique within the organization.
CREATE TABLE variant_barcodes (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  barcode         text NOT NULL,
  variant_id      uuid NOT NULL REFERENCES product_variants(id),
  PRIMARY KEY (organization_id, barcode)
);

-- Conversions are explicit per product; nothing is converted implicitly.
CREATE TABLE product_unit_conversions (
  product_id   uuid NOT NULL REFERENCES products(id),
  from_unit_id uuid NOT NULL REFERENCES units(id),
  to_unit_id   uuid NOT NULL REFERENCES units(id),
  factor       numeric(20, 8) NOT NULL CHECK (factor > 0),  -- 1 from = factor to
  PRIMARY KEY (product_id, from_unit_id, to_unit_id),
  CHECK (from_unit_id <> to_unit_id)
);
