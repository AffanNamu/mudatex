-- Inventory ledger.
-- stock_movements is the immutable source of truth; stock_balances is a projection
-- updated in the same transaction. No cost or valuation columns exist on purpose:
-- the costing method is an open ADR (005) and must not be assumed here.

ALTER TABLE product_variants
  ADD COLUMN tracking text NOT NULL DEFAULT 'none' CHECK (tracking IN ('none', 'lot', 'roll'));

CREATE TYPE lot_kind AS ENUM ('lot', 'roll');

CREATE TABLE stock_lots (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  variant_id       uuid NOT NULL REFERENCES product_variants(id),
  kind             lot_kind NOT NULL,
  code             text NOT NULL,
  parent_lot_id    uuid REFERENCES stock_lots(id),   -- roll lineage after a split
  initial_quantity numeric(20, 6) NOT NULL CHECK (initial_quantity > 0),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, variant_id, code)
);

-- A variant's tracking mode cannot change once stock history exists.
CREATE TABLE stock_tracking_lock (variant_id uuid PRIMARY KEY REFERENCES product_variants(id));

CREATE FUNCTION forbid_tracking_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tracking <> OLD.tracking AND EXISTS (SELECT 1 FROM stock_tracking_lock WHERE variant_id = OLD.id) THEN
    RAISE EXCEPTION 'tracking cannot change after stock movements exist';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER product_variants_tracking BEFORE UPDATE ON product_variants
  FOR EACH ROW EXECUTE FUNCTION forbid_tracking_change();

CREATE TYPE stock_state AS ENUM ('on_hand', 'in_transit');
CREATE TYPE movement_type AS ENUM (
  'receipt', 'issue', 'adjustment', 'transfer_dispatch', 'transfer_receive', 'transfer_cancel', 'roll_split'
);

CREATE TABLE stock_movements (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  command_id      uuid NOT NULL,                       -- movements posted together
  movement_type   movement_type NOT NULL,
  location_id     uuid NOT NULL REFERENCES locations(id),
  variant_id      uuid NOT NULL REFERENCES product_variants(id),
  lot_id          uuid REFERENCES stock_lots(id),
  state           stock_state NOT NULL DEFAULT 'on_hand',
  quantity        numeric(20, 6) NOT NULL CHECK (quantity <> 0),   -- signed, base unit
  reason          text,
  reference_type  text,
  reference_id    text,
  actor_user_id   uuid REFERENCES users(id),
  request_id      text,
  occurred_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stock_movements_stock_idx ON stock_movements (location_id, variant_id);
CREATE INDEX stock_movements_command_idx ON stock_movements (command_id);
CREATE INDEX stock_movements_reference_idx ON stock_movements (reference_type, reference_id);

CREATE FUNCTION stock_movements_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'stock_movements is append-only; post a correcting movement instead';
END;
$$;
CREATE TRIGGER stock_movements_no_change BEFORE UPDATE OR DELETE ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION stock_movements_immutable();
CREATE TRIGGER stock_movements_no_truncate BEFORE TRUNCATE ON stock_movements
  FOR EACH STATEMENT EXECUTE FUNCTION stock_movements_immutable();

CREATE TABLE stock_balances (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  location_id     uuid NOT NULL REFERENCES locations(id),
  variant_id      uuid NOT NULL REFERENCES product_variants(id),
  lot_id          uuid REFERENCES stock_lots(id),
  lot_key         uuid GENERATED ALWAYS AS (COALESCE(lot_id, '00000000-0000-0000-0000-000000000000'::uuid)) STORED,
  state           stock_state NOT NULL,
  quantity        numeric(20, 6) NOT NULL DEFAULT 0,
  reserved        numeric(20, 6) NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (location_id, variant_id, lot_key, state),
  -- Backstops: stock can never go negative or be reserved beyond what is on hand.
  CONSTRAINT stock_balances_quantity_check CHECK (quantity >= 0),
  CONSTRAINT stock_balances_reserved_check CHECK (reserved >= 0 AND reserved <= quantity),
  CONSTRAINT stock_balances_transit_check CHECK (state = 'on_hand' OR reserved = 0)
);

CREATE TABLE stock_reservations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES organizations(id),
  location_id        uuid NOT NULL REFERENCES locations(id),
  variant_id         uuid NOT NULL REFERENCES product_variants(id),
  lot_id             uuid REFERENCES stock_lots(id),
  quantity           numeric(20, 6) NOT NULL CHECK (quantity > 0),
  fulfilled_quantity numeric(20, 6) NOT NULL DEFAULT 0,
  released_quantity  numeric(20, 6) NOT NULL DEFAULT 0,
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
  reference_type     text NOT NULL,
  reference_id       text NOT NULL,
  expires_at         timestamptz,
  created_by         uuid NOT NULL REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  closed_at          timestamptz,
  CHECK (fulfilled_quantity >= 0 AND released_quantity >= 0 AND fulfilled_quantity + released_quantity <= quantity)
);
CREATE INDEX stock_reservations_active_idx ON stock_reservations (expires_at) WHERE status = 'active';

CREATE TABLE stock_transfers (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id         uuid NOT NULL REFERENCES organizations(id),
  source_location_id      uuid NOT NULL REFERENCES locations(id),
  destination_location_id uuid NOT NULL REFERENCES locations(id),
  status                  text NOT NULL DEFAULT 'in_transit' CHECK (status IN ('in_transit', 'completed', 'cancelled')),
  reference               text,
  created_by              uuid NOT NULL REFERENCES users(id),
  created_at              timestamptz NOT NULL DEFAULT now(),
  closed_at               timestamptz,
  CHECK (source_location_id <> destination_location_id)
);

CREATE TABLE stock_transfer_lines (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_id        uuid NOT NULL REFERENCES stock_transfers(id),
  variant_id         uuid NOT NULL REFERENCES product_variants(id),
  lot_id             uuid REFERENCES stock_lots(id),
  quantity           numeric(20, 6) NOT NULL CHECK (quantity > 0),
  received_quantity  numeric(20, 6) NOT NULL DEFAULT 0,
  cancelled_quantity numeric(20, 6) NOT NULL DEFAULT 0,
  CHECK (received_quantity >= 0 AND cancelled_quantity >= 0 AND received_quantity + cancelled_quantity <= quantity)
);

-- Adjustments are maker-checker documents: they change nothing until a different user approves.
CREATE TABLE stock_adjustments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  location_id     uuid NOT NULL REFERENCES locations(id),
  reason          text NOT NULL CHECK (length(btrim(reason)) >= 5),
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  requested_by    uuid NOT NULL REFERENCES users(id),
  decided_by      uuid REFERENCES users(id),
  decided_at      timestamptz,
  decision_note   text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (status = 'pending' OR decided_by IS NOT NULL),
  CHECK (decided_by IS NULL OR decided_by <> requested_by)
);

CREATE TABLE stock_adjustment_lines (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  adjustment_id uuid NOT NULL REFERENCES stock_adjustments(id),
  variant_id    uuid NOT NULL REFERENCES product_variants(id),
  lot_id        uuid REFERENCES stock_lots(id),
  delta         numeric(20, 6) NOT NULL CHECK (delta <> 0)
);

-- Replay protection for retried commands. The key row is written in the same
-- transaction as the command's effects, so a duplicate sees all of them or none.
CREATE TABLE idempotency_keys (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  user_id         uuid NOT NULL REFERENCES users(id),
  key             text NOT NULL,
  request_hash    text NOT NULL,
  status_code     int,
  response_body   jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id, key)
);
