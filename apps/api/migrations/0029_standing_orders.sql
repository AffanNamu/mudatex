-- Standing orders: a trade buyer asks for the same goods to be ordered again on a schedule. Each time one is due the
-- system places an ordinary order for them, at that day's trade prices, subject to the same stock and credit rules.
CREATE TABLE standing_orders (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  storefront_id    uuid NOT NULL REFERENCES storefronts(id),
  trade_account_id uuid NOT NULL REFERENCES trade_accounts(id),
  customer_id      uuid NOT NULL REFERENCES customers(id),
  address_id       uuid NOT NULL REFERENCES customer_addresses(id),
  payment_method   text NOT NULL CHECK (payment_method IN ('account', 'bank_transfer')),
  frequency        text NOT NULL CHECK (frequency IN ('weekly', 'fortnightly', 'monthly')),
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'cancelled')),
  next_run_on      date NOT NULL,
  source_order_no  text,
  failures_in_row  int NOT NULL DEFAULT 0,
  paused_reason    text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX standing_orders_due ON standing_orders (next_run_on) WHERE status = 'active';
CREATE INDEX standing_orders_customer ON standing_orders (customer_id);

CREATE TABLE standing_order_lines (
  standing_order_id uuid NOT NULL REFERENCES standing_orders(id),
  variant_id        uuid NOT NULL REFERENCES product_variants(id),
  quantity          numeric(20, 6) NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (standing_order_id, variant_id)
);

CREATE TABLE standing_order_runs (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  standing_order_id uuid NOT NULL REFERENCES standing_orders(id),
  run_on            date NOT NULL,
  outcome           text NOT NULL CHECK (outcome IN ('placed', 'failed')),
  order_id          uuid REFERENCES sales_orders(id),
  reason            text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (standing_order_id, run_on)
);
