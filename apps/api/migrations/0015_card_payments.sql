-- Customer-facing commerce, part 3: card and online-bank payments through a payment provider (Paystack).
-- The server asks the provider to confirm every payment itself and compares the amount with the order; nothing the
-- browser reports is trusted. One row per attempt to pay, keyed by the provider reference.

ALTER TABLE storefronts ADD COLUMN site_url text CHECK (site_url IS NULL OR site_url ~ '^(https://|http://localhost)');

CREATE TABLE payment_attempts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  order_id     uuid NOT NULL REFERENCES sales_orders(id),
  provider     text NOT NULL CHECK (provider IN ('paystack')),
  reference    text NOT NULL UNIQUE,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency     char(3) NOT NULL,
  status       text NOT NULL DEFAULT 'initiated' CHECK (status IN ('initiated', 'succeeded', 'failed', 'mismatch')),
  detail       text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  settled_at   timestamptz
);
CREATE INDEX payment_attempts_order ON payment_attempts (order_id, created_at DESC);

-- A card payment can also arrive for an order that has since closed; the payment is kept and the refund recorded.
ALTER TABLE sales_order_payments DROP CONSTRAINT sales_order_payments_method_check;
ALTER TABLE sales_order_payments ADD CONSTRAINT sales_order_payments_method_check CHECK (method IN ('card', 'bank_transfer'));
