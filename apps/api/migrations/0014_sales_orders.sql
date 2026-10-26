-- Customer-facing commerce, part 2: sales orders.
-- An order prices its lines on the server, reserves stock at placement, and moves through a fixed set of states.
-- Money is integer minor units. Orders and their lines are never deleted; cancelling or expiring releases the stock.

-- Online orders are reserved on behalf of a customer, who is not a staff user.
ALTER TABLE stock_reservations ALTER COLUMN created_by DROP NOT NULL;

CREATE TABLE sales_orders (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES organizations(id),
  legal_entity_id    uuid NOT NULL REFERENCES legal_entities(id),
  storefront_id      uuid NOT NULL REFERENCES storefronts(id),
  customer_id        uuid NOT NULL REFERENCES customers(id),
  order_no           text NOT NULL,
  status             text NOT NULL CHECK (status IN ('pending_payment', 'paid', 'processing', 'shipped', 'delivered', 'cancelled', 'expired')),
  currency           char(3) NOT NULL REFERENCES currencies(code),
  subtotal_minor     bigint NOT NULL CHECK (subtotal_minor >= 0),
  tax_minor          bigint NOT NULL CHECK (tax_minor >= 0),
  delivery_fee_minor bigint NOT NULL CHECK (delivery_fee_minor >= 0),
  total_minor        bigint NOT NULL CHECK (total_minor > 0),
  paid_minor         bigint NOT NULL DEFAULT 0 CHECK (paid_minor >= 0),
  refund_due_minor   bigint NOT NULL DEFAULT 0 CHECK (refund_due_minor >= 0),
  payment_method     text NOT NULL CHECK (payment_method IN ('card', 'bank_transfer')),
  contact            jsonb NOT NULL,     -- name, email, phone as given at checkout
  delivery           jsonb NOT NULL,     -- address snapshot, zone, estimated days
  note               text,
  carrier            text,
  tracking_ref       text,
  cancel_reason      text,
  client_key         text NOT NULL,      -- the shopper's Idempotency-Key
  request_hash       text NOT NULL,
  expires_at         timestamptz NOT NULL,
  placed_at          timestamptz NOT NULL DEFAULT now(),
  paid_at            timestamptz,
  shipped_at         timestamptz,
  delivered_at       timestamptz,
  closed_at          timestamptz,
  UNIQUE (legal_entity_id, order_no),
  UNIQUE (customer_id, client_key),
  -- subtotal is the sum of line totals (tax included); tax_minor is the tax contained in or added to it, for reporting
  CHECK (total_minor = subtotal_minor + delivery_fee_minor)
);
CREATE INDEX sales_orders_customer ON sales_orders (customer_id, placed_at DESC);
CREATE INDEX sales_orders_desk ON sales_orders (organization_id, status, placed_at DESC);
CREATE INDEX sales_orders_expiry ON sales_orders (expires_at) WHERE status = 'pending_payment';

CREATE TABLE sales_order_lines (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      uuid NOT NULL REFERENCES sales_orders(id),
  line_no       int NOT NULL,
  variant_id    uuid NOT NULL REFERENCES product_variants(id),
  sku           text NOT NULL,
  title         text NOT NULL,
  quantity      numeric(20, 6) NOT NULL CHECK (quantity > 0),   -- base unit
  unit_price    numeric(20, 4) NOT NULL,
  tax_code      text,
  tax_rate      numeric(9, 6),
  tax_inclusive boolean,
  gross_minor   bigint NOT NULL,
  tax_minor     bigint NOT NULL,
  total_minor   bigint NOT NULL,                                 -- what the shopper pays for the line, tax included
  UNIQUE (order_id, line_no)
);

CREATE TABLE sales_order_events (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id   uuid NOT NULL REFERENCES sales_orders(id),
  status     text NOT NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('customer', 'staff', 'system')),
  actor_id   uuid,
  note       text,
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sales_order_events_order ON sales_order_events (order_id, id);

CREATE TABLE sales_order_payments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    uuid NOT NULL REFERENCES sales_orders(id),
  method      text NOT NULL CHECK (method IN ('card', 'bank_transfer')),
  provider    text,
  reference   text NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  recorded_by uuid REFERENCES users(id),     -- NULL when a payment provider confirmed it
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- one provider or bank reference can settle only one order
  UNIQUE (method, reference)
);

-- These records are history: order lines and events cannot be changed or removed.
CREATE FUNCTION sales_order_history_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;
CREATE TRIGGER sales_order_lines_no_change BEFORE UPDATE OR DELETE ON sales_order_lines
  FOR EACH ROW EXECUTE FUNCTION sales_order_history_immutable();
CREATE TRIGGER sales_order_events_no_change BEFORE UPDATE OR DELETE ON sales_order_events
  FOR EACH ROW EXECUTE FUNCTION sales_order_history_immutable();
CREATE TRIGGER sales_order_payments_no_change BEFORE UPDATE OR DELETE ON sales_order_payments
  FOR EACH ROW EXECUTE FUNCTION sales_order_history_immutable();

INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p FROM roles r, unnest(ARRAY['orders.read', 'orders.fulfil', 'orders.payment.record', 'orders.cancel']) AS p
 WHERE r.key = 'group_admin'
ON CONFLICT DO NOTHING;
