-- Pricing, tax configuration and retail POS.
-- Money is stored as integer minor units (bigint); unit prices are exact decimals.
-- Tax codes and the rounding rule are configuration/policy to be approved by finance and
-- local tax advisers; nothing here is a statement of any country's tax law.

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- A returned item can be put back into stock.
ALTER TYPE movement_type ADD VALUE IF NOT EXISTS 'sale_return';

CREATE TABLE currencies (
  code       char(3) PRIMARY KEY CHECK (code ~ '^[A-Z]{3}$'),
  minor_unit smallint NOT NULL CHECK (minor_unit BETWEEN 0 AND 4)
);
INSERT INTO currencies (code, minor_unit) VALUES
  ('NGN', 2), ('GHS', 2), ('KES', 2), ('ZAR', 2), ('XOF', 0), ('UGX', 0),
  ('USD', 2), ('EUR', 2), ('GBP', 2), ('AED', 2), ('CNY', 2), ('INR', 2);

CREATE TABLE tax_codes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  legal_entity_id uuid NOT NULL REFERENCES legal_entities(id),
  code            text NOT NULL,
  name            text NOT NULL,
  rate            numeric(9, 6) NOT NULL CHECK (rate >= 0 AND rate < 1),   -- 0.075 = 7.5%
  price_inclusive boolean NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (legal_entity_id, code)
);

-- Tax codes are immutable: a rate change is a new code, so past sales stay explainable.
CREATE FUNCTION tax_codes_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'tax codes are immutable; create a new code for a new rate';
END;
$$;
CREATE TRIGGER tax_codes_no_change BEFORE UPDATE OR DELETE ON tax_codes
  FOR EACH ROW EXECUTE FUNCTION tax_codes_immutable();

CREATE TABLE price_lists (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  legal_entity_id uuid NOT NULL REFERENCES legal_entities(id),
  name            text NOT NULL,
  currency        char(3) NOT NULL REFERENCES currencies(code),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (legal_entity_id, name)
);

-- Effective-dated prices per base unit. Periods for one variant never overlap.
CREATE TABLE price_list_items (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  price_list_id  uuid NOT NULL REFERENCES price_lists(id),
  variant_id     uuid NOT NULL REFERENCES product_variants(id),
  unit_price     numeric(20, 4) NOT NULL CHECK (unit_price >= 0),
  tax_code_id    uuid REFERENCES tax_codes(id),
  effective_from timestamptz NOT NULL,
  effective_to   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to > effective_from),
  EXCLUDE USING gist (price_list_id WITH =, variant_id WITH =, tstzrange(effective_from, effective_to) WITH &&)
);

CREATE TABLE pos_registers (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id        uuid NOT NULL REFERENCES organizations(id),
  legal_entity_id        uuid NOT NULL REFERENCES legal_entities(id),
  location_id            uuid NOT NULL REFERENCES locations(id),
  code                   text NOT NULL CHECK (code ~ '^[A-Z0-9]{2,10}$'),
  name                   text NOT NULL,
  price_list_id          uuid NOT NULL REFERENCES price_lists(id),
  -- discounts above this need pos.discount.override
  max_discount_bps       int NOT NULL DEFAULT 0 CHECK (max_discount_bps BETWEEN 0 AND 10000),
  -- refunds above this (minor units) need pos.refund.approve; NULL = no limit
  refund_threshold_minor bigint CHECK (refund_threshold_minor IS NULL OR refund_threshold_minor >= 0),
  next_receipt_no        bigint NOT NULL DEFAULT 1,
  next_return_no         bigint NOT NULL DEFAULT 1,
  status                 text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (legal_entity_id, code)
);

CREATE TABLE pos_sessions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL REFERENCES organizations(id),
  register_id          uuid NOT NULL REFERENCES pos_registers(id),
  cashier_id           uuid NOT NULL REFERENCES users(id),
  opening_float_minor  bigint NOT NULL CHECK (opening_float_minor >= 0),
  status               text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  opened_at            timestamptz NOT NULL DEFAULT now(),
  closed_at            timestamptz,
  closed_by            uuid REFERENCES users(id),
  expected_cash_minor  bigint,
  counted_cash_minor   bigint CHECK (counted_cash_minor IS NULL OR counted_cash_minor >= 0),
  variance_minor       bigint,
  close_note           text
);
CREATE UNIQUE INDEX pos_sessions_one_open_per_register ON pos_sessions (register_id) WHERE status = 'open';

CREATE TABLE pos_sales (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  legal_entity_id  uuid NOT NULL REFERENCES legal_entities(id),
  location_id      uuid NOT NULL REFERENCES locations(id),
  register_id      uuid NOT NULL REFERENCES pos_registers(id),
  session_id       uuid NOT NULL REFERENCES pos_sessions(id),
  receipt_number   text NOT NULL,
  status           text NOT NULL CHECK (status IN ('pending_payment', 'completed', 'cancelled')),
  currency         char(3) NOT NULL REFERENCES currencies(code),
  minor_unit       smallint NOT NULL,
  price_list_id    uuid NOT NULL REFERENCES price_lists(id),
  subtotal_minor   bigint NOT NULL,   -- sum of line gross (quantity x price)
  discount_minor   bigint NOT NULL,
  tax_minor        bigint NOT NULL,   -- includes tax contained in inclusive prices
  total_minor      bigint NOT NULL CHECK (total_minor > 0),
  cashier_id       uuid NOT NULL REFERENCES users(id),
  note             text,
  device_id        text,
  client_timestamp timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz,
  UNIQUE (legal_entity_id, receipt_number)
);
CREATE INDEX pos_sales_session_idx ON pos_sales (session_id);

CREATE TABLE pos_sale_lines (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id            uuid NOT NULL REFERENCES pos_sales(id),
  line_no            int NOT NULL,
  variant_id         uuid NOT NULL REFERENCES product_variants(id),
  lot_id             uuid REFERENCES stock_lots(id),
  quantity           numeric(20, 6) NOT NULL CHECK (quantity > 0),    -- base unit
  returned_quantity  numeric(20, 6) NOT NULL DEFAULT 0,
  unit_price         numeric(20, 4) NOT NULL,                         -- snapshot, per base unit
  price_list_item_id uuid REFERENCES price_list_items(id),
  tax_code           text,
  tax_rate           numeric(9, 6) NOT NULL DEFAULT 0,
  tax_inclusive      boolean NOT NULL DEFAULT false,
  discount_bps       int,
  gross_minor        bigint NOT NULL,
  discount_minor     bigint NOT NULL CHECK (discount_minor >= 0),
  tax_minor          bigint NOT NULL,
  total_minor        bigint NOT NULL,
  UNIQUE (sale_id, line_no),
  CHECK (returned_quantity >= 0 AND returned_quantity <= quantity),
  CHECK (discount_minor <= gross_minor)
);

CREATE TABLE pos_payments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  sale_id        uuid NOT NULL REFERENCES pos_sales(id),
  method         text NOT NULL CHECK (method IN ('cash', 'card', 'bank_transfer', 'mobile_money')),
  amount_minor   bigint NOT NULL CHECK (amount_minor > 0),   -- applied to the sale
  tendered_minor bigint,                                     -- cash handed over
  change_minor   bigint,
  reference      text,
  status         text NOT NULL CHECK (status IN ('confirmed', 'pending', 'failed', 'voided')),
  created_by     uuid NOT NULL REFERENCES users(id),
  verified_by    uuid REFERENCES users(id),
  verified_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (method = 'cash' OR reference IS NOT NULL),
  CHECK (method <> 'cash' OR (tendered_minor >= amount_minor AND change_minor = tendered_minor - amount_minor)),
  CHECK (verified_by IS NULL OR verified_by <> created_by)
);
CREATE INDEX pos_payments_sale_idx ON pos_payments (sale_id);

CREATE TABLE pos_returns (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES organizations(id),
  sale_id            uuid NOT NULL REFERENCES pos_sales(id),
  session_id         uuid NOT NULL REFERENCES pos_sessions(id),
  return_number      text NOT NULL,
  reason             text NOT NULL CHECK (length(btrim(reason)) >= 5),
  refund_method      text NOT NULL CHECK (refund_method IN ('cash', 'card', 'bank_transfer', 'mobile_money')),
  refund_reference   text,
  refund_total_minor bigint NOT NULL CHECK (refund_total_minor >= 0),
  refund_status      text NOT NULL CHECK (refund_status IN ('recorded', 'pending_disbursement', 'disbursed')),
  processed_by       uuid NOT NULL REFERENCES users(id),
  disbursed_by       uuid REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, return_number),
  CHECK (disbursed_by IS NULL OR disbursed_by <> processed_by)
);

CREATE TABLE pos_return_lines (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  return_id          uuid NOT NULL REFERENCES pos_returns(id),
  sale_line_id       uuid NOT NULL REFERENCES pos_sale_lines(id),
  quantity           numeric(20, 6) NOT NULL CHECK (quantity > 0),
  restock            boolean NOT NULL,
  refund_minor       bigint NOT NULL CHECK (refund_minor >= 0),
  tax_refund_minor   bigint NOT NULL CHECK (tax_refund_minor >= 0)
);
