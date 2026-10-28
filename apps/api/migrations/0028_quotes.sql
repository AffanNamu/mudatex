-- Quotes for trade buyers: staff price a list of goods at agreed prices for a limited time; the buyer accepts it in the
-- shop and the order is placed at exactly those prices. Nothing is reserved until the buyer accepts.
CREATE TABLE quotes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  legal_entity_id  uuid NOT NULL REFERENCES legal_entities(id),
  storefront_id    uuid NOT NULL REFERENCES storefronts(id),
  trade_account_id uuid NOT NULL REFERENCES trade_accounts(id),
  customer_id      uuid NOT NULL REFERENCES customers(id),
  quote_no         text NOT NULL,
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'accepted', 'declined', 'cancelled')),
  currency         char(3) NOT NULL REFERENCES currencies(code),
  valid_until      date NOT NULL,
  note             text,
  subtotal_minor   bigint NOT NULL DEFAULT 0,   -- goods, tax included (delivery is added when the order is placed)
  tax_minor        bigint NOT NULL DEFAULT 0,
  created_by       uuid NOT NULL REFERENCES users(id),
  sent_at          timestamptz,
  decided_at       timestamptz,
  order_id         uuid REFERENCES sales_orders(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (legal_entity_id, quote_no)
);
CREATE INDEX quotes_customer ON quotes (customer_id, status);
CREATE INDEX quotes_status ON quotes (organization_id, status, created_at DESC);

CREATE TABLE quote_lines (
  quote_id      uuid NOT NULL REFERENCES quotes(id),
  line_no       int NOT NULL,
  variant_id    uuid NOT NULL REFERENCES product_variants(id),
  sku           text NOT NULL,
  title         text NOT NULL,
  quantity      numeric(20, 6) NOT NULL CHECK (quantity > 0),
  unit_price    numeric(20, 4) NOT NULL,
  list_price    numeric(20, 4) NOT NULL,      -- what the trade price list said when the quote was priced
  tax_code      text,
  tax_rate      numeric(9, 6),
  tax_inclusive boolean,
  gross_minor   bigint NOT NULL,
  tax_minor     bigint NOT NULL,
  total_minor   bigint NOT NULL,
  PRIMARY KEY (quote_id, line_no)
);

ALTER TABLE sales_orders ADD COLUMN quote_id uuid REFERENCES quotes(id);

INSERT INTO role_permissions (role_id, permission)
SELECT id, p FROM roles, unnest(ARRAY['quotes.manage', 'quotes.price.override']) AS p WHERE key = 'group_admin'
ON CONFLICT DO NOTHING;
