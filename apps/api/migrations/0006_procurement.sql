-- Procurement: suppliers, purchase orders, goods receipts and supplier returns.
-- Purchase prices here are the agreed commercial price of an order. They are NOT inventory
-- valuation: the costing method (ADR 005) is undecided and receiving posts quantities only.
-- Supplier bank details are deliberately not stored; they belong with payables and need
-- their own change controls.

ALTER TYPE movement_type ADD VALUE IF NOT EXISTS 'supplier_return';

-- Gap-free document numbers per legal entity and kind, allocated inside the document's transaction.
CREATE TABLE document_sequences (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  legal_entity_id uuid NOT NULL REFERENCES legal_entities(id),
  kind            text NOT NULL,
  next_no         bigint NOT NULL,
  PRIMARY KEY (legal_entity_id, kind)
);

CREATE TABLE suppliers (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organizations(id),
  code                text NOT NULL CHECK (code ~ '^[A-Z0-9_-]{2,20}$'),
  name                text NOT NULL,
  country_code        char(2) NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
  default_currency    char(3) NOT NULL REFERENCES currencies(code),
  payment_terms_days  int NOT NULL DEFAULT 0 CHECK (payment_terms_days BETWEEN 0 AND 365),
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'blocked')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code)
);

CREATE TABLE purchase_orders (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id         uuid NOT NULL REFERENCES organizations(id),
  legal_entity_id         uuid NOT NULL REFERENCES legal_entities(id),
  supplier_id             uuid NOT NULL REFERENCES suppliers(id),
  destination_location_id uuid NOT NULL REFERENCES locations(id),
  po_number               text NOT NULL,
  status                  text NOT NULL DEFAULT 'draft'
                          CHECK (status IN ('draft', 'pending_approval', 'approved', 'partially_received', 'received', 'cancelled', 'closed')),
  currency                char(3) NOT NULL REFERENCES currencies(code),
  minor_unit              smallint NOT NULL,
  total_minor             bigint NOT NULL DEFAULT 0,
  over_receipt_tolerance_bps int NOT NULL DEFAULT 0 CHECK (over_receipt_tolerance_bps BETWEEN 0 AND 5000),
  expected_date           date,
  note                    text,
  created_by              uuid NOT NULL REFERENCES users(id),
  submitted_at            timestamptz,
  decided_by              uuid REFERENCES users(id),
  decided_at              timestamptz,
  decision_note           text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (legal_entity_id, po_number),
  CHECK (decided_by IS NULL OR decided_by <> created_by)
);
CREATE INDEX purchase_orders_supplier_idx ON purchase_orders (supplier_id);

CREATE TABLE purchase_order_lines (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_order_id uuid NOT NULL REFERENCES purchase_orders(id),
  line_no           int NOT NULL,
  variant_id        uuid NOT NULL REFERENCES product_variants(id),
  quantity          numeric(20, 6) NOT NULL CHECK (quantity > 0),         -- base unit
  unit_price        numeric(20, 4) NOT NULL CHECK (unit_price >= 0),      -- per base unit, PO currency
  total_minor       bigint NOT NULL CHECK (total_minor >= 0),
  received_quantity numeric(20, 6) NOT NULL DEFAULT 0,
  returned_quantity numeric(20, 6) NOT NULL DEFAULT 0,
  UNIQUE (purchase_order_id, line_no),
  CHECK (received_quantity >= 0 AND returned_quantity >= 0 AND returned_quantity <= received_quantity)
);

CREATE TABLE goods_receipts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES organizations(id),
  purchase_order_id uuid NOT NULL REFERENCES purchase_orders(id),
  receipt_number    text NOT NULL,
  delivery_note     text,
  received_by       uuid NOT NULL REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, receipt_number)
);

CREATE TABLE goods_receipt_lines (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  goods_receipt_id    uuid NOT NULL REFERENCES goods_receipts(id),
  po_line_id          uuid NOT NULL REFERENCES purchase_order_lines(id),
  lot_id              uuid REFERENCES stock_lots(id),
  quantity            numeric(20, 6) NOT NULL DEFAULT 0 CHECK (quantity >= 0),          -- accepted into stock
  rejected_quantity   numeric(20, 6) NOT NULL DEFAULT 0 CHECK (rejected_quantity >= 0), -- recorded, not stocked
  reject_reason       text,
  CHECK (quantity > 0 OR rejected_quantity > 0),
  CHECK (rejected_quantity = 0 OR reject_reason IS NOT NULL)
);

CREATE TABLE supplier_returns (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES organizations(id),
  purchase_order_id uuid NOT NULL REFERENCES purchase_orders(id),
  return_number     text NOT NULL,
  reason            text NOT NULL CHECK (length(btrim(reason)) >= 5),
  created_by        uuid NOT NULL REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, return_number)
);

CREATE TABLE supplier_return_lines (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_return_id uuid NOT NULL REFERENCES supplier_returns(id),
  po_line_id         uuid NOT NULL REFERENCES purchase_order_lines(id),
  lot_id             uuid REFERENCES stock_lots(id),
  quantity           numeric(20, 6) NOT NULL CHECK (quantity > 0)
);
