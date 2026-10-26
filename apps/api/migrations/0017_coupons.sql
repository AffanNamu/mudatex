-- Customer-facing commerce, part 5: coupons. A coupon is a percentage off the basket, checked and applied by the
-- server when pricing; the browser only names the code. Lines remember their discount, so an order always explains itself.

CREATE TABLE coupons (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES organizations(id),
  storefront_id      uuid NOT NULL REFERENCES storefronts(id),
  code               text NOT NULL CHECK (code ~ '^[A-Z0-9]{3,20}$'),
  description        text,
  percent_bps        int NOT NULL CHECK (percent_bps BETWEEN 1 AND 9000),
  min_subtotal_minor bigint NOT NULL DEFAULT 0 CHECK (min_subtotal_minor >= 0),
  max_redemptions    int CHECK (max_redemptions IS NULL OR max_redemptions > 0),
  per_customer_limit int NOT NULL DEFAULT 1 CHECK (per_customer_limit > 0),
  starts_at          timestamptz,
  ends_at            timestamptz,
  active             boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (storefront_id, code),
  CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at)
);

ALTER TABLE sales_orders ADD COLUMN discount_minor bigint NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
                         ADD COLUMN coupon_id uuid REFERENCES coupons(id);

-- Lines are append-only; the new column is added before any line could be changed.
ALTER TABLE sales_order_lines ADD COLUMN discount_minor bigint NOT NULL DEFAULT 0 CHECK (discount_minor >= 0);

CREATE INDEX sales_orders_coupon ON sales_orders (coupon_id) WHERE coupon_id IS NOT NULL;
