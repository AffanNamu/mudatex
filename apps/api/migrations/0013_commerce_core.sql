-- Customer-facing commerce, part 1: storefronts, published catalogue, customers, wishlists, delivery zones.
-- A storefront is configuration over the existing engine: one legal entity, one price list, a set of stock-holding
-- locations. Prices, tax and availability are always computed on the server from the same data the tills use.

CREATE TABLE storefronts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES organizations(id),
  legal_entity_id    uuid NOT NULL REFERENCES legal_entities(id),
  slug               text NOT NULL CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) <= 60),
  name               text NOT NULL,
  price_list_id      uuid NOT NULL REFERENCES price_lists(id),
  currency           char(3) NOT NULL REFERENCES currencies(code),
  -- stock that may be sold online; availability sums these locations only
  stock_location_ids uuid[] NOT NULL CHECK (cardinality(stock_location_ids) > 0),
  status             text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'live', 'closed')),
  tagline            text,
  contact            jsonb NOT NULL DEFAULT '{}'::jsonb,   -- whatsapp, phone, email shown on the site
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (slug)
);

CREATE TABLE storefront_departments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  storefront_id uuid NOT NULL REFERENCES storefronts(id),
  slug          text NOT NULL CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name          text NOT NULL,
  image_url     text,
  sort          int NOT NULL DEFAULT 0,
  UNIQUE (storefront_id, slug)
);

-- Publishing is separate from the catalogue: a product is sold online only when it has a row here and published = true.
CREATE TABLE storefront_products (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  storefront_id uuid NOT NULL REFERENCES storefronts(id),
  product_id    uuid NOT NULL REFERENCES products(id),
  slug          text NOT NULL CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  title         text NOT NULL,
  description   text,
  department_id uuid REFERENCES storefront_departments(id),
  brand         text,
  images        jsonb NOT NULL DEFAULT '[]'::jsonb,
  badges        text[] NOT NULL DEFAULT '{}',
  published     boolean NOT NULL DEFAULT false,
  sort          int NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (storefront_id, product_id),
  UNIQUE (storefront_id, slug)
);
CREATE INDEX storefront_products_listing ON storefront_products (storefront_id, published, department_id);

CREATE TABLE customers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  external_subject text NOT NULL,
  email            text NOT NULL,
  full_name        text NOT NULL,
  phone            text,
  marketing_opt_in boolean NOT NULL DEFAULT false,
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'blocked')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (external_subject),
  UNIQUE (organization_id, email)
);

CREATE TABLE customer_addresses (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id  uuid NOT NULL REFERENCES customers(id),
  label        text NOT NULL,
  recipient    text NOT NULL,
  phone        text NOT NULL,
  line1        text NOT NULL,
  line2        text,
  city         text NOT NULL,
  state        text NOT NULL,
  country_code char(2) NOT NULL,
  is_default   boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX customer_addresses_one_default ON customer_addresses (customer_id) WHERE is_default;

CREATE TABLE wishlist_items (
  customer_id           uuid NOT NULL REFERENCES customers(id),
  storefront_product_id uuid NOT NULL REFERENCES storefront_products(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, storefront_product_id)
);

CREATE TABLE delivery_zones (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  storefront_id   uuid NOT NULL REFERENCES storefronts(id),
  name            text NOT NULL,
  country_code    char(2) NOT NULL,
  -- empty = the whole country; otherwise only these states/regions (lower-case)
  states          text[] NOT NULL DEFAULT '{}',
  fee_minor       bigint NOT NULL CHECK (fee_minor >= 0),
  free_over_minor bigint CHECK (free_over_minor IS NULL OR free_over_minor > 0),
  eta_days_min    int NOT NULL DEFAULT 1 CHECK (eta_days_min >= 0),
  eta_days_max    int NOT NULL DEFAULT 3,
  active          boolean NOT NULL DEFAULT true,
  CHECK (eta_days_max >= eta_days_min)
);

INSERT INTO role_permissions (role_id, permission)
SELECT id, 'storefront.manage' FROM roles WHERE key = 'group_admin'
ON CONFLICT DO NOTHING;
