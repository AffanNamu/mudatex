-- Wholesale: trade accounts. A business applies, staff approve it with a trade price list, a credit limit and payment
-- terms, and its orders are then priced from that list and may be placed on account. Nothing about money is decided by
-- the browser: credit is checked inside the order's own transaction.

CREATE TABLE trade_accounts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES organizations(id),
  storefront_id      uuid NOT NULL REFERENCES storefronts(id),
  customer_id        uuid NOT NULL REFERENCES customers(id),
  business_name      text NOT NULL,
  tax_id             text,
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'suspended')),
  price_list_id      uuid REFERENCES price_lists(id),
  credit_limit_minor bigint NOT NULL DEFAULT 0 CHECK (credit_limit_minor >= 0),
  payment_terms_days int NOT NULL DEFAULT 0 CHECK (payment_terms_days BETWEEN 0 AND 180),
  note               text,
  reviewed_by        uuid REFERENCES users(id),
  reviewed_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (storefront_id, customer_id),
  CHECK (status <> 'approved' OR price_list_id IS NOT NULL)
);

-- Orders on account are confirmed straight away and settled later by payments recorded against them.
ALTER TABLE sales_orders DROP CONSTRAINT sales_orders_status_check;
ALTER TABLE sales_orders ADD CONSTRAINT sales_orders_status_check
  CHECK (status IN ('pending_payment', 'confirmed', 'paid', 'processing', 'shipped', 'delivered', 'cancelled', 'expired'));
ALTER TABLE sales_orders DROP CONSTRAINT sales_orders_payment_method_check;
ALTER TABLE sales_orders ADD CONSTRAINT sales_orders_payment_method_check CHECK (payment_method IN ('card', 'bank_transfer', 'account'));
ALTER TABLE sales_orders ADD COLUMN due_on date;

INSERT INTO role_permissions (role_id, permission)
SELECT id, 'trade.manage' FROM roles WHERE key = 'group_admin'
ON CONFLICT DO NOTHING;
