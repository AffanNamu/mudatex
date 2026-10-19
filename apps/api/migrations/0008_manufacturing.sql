-- Manufacturing (quantity side only) and quality holds.
-- There are deliberately no cost, rate, overhead or WIP-valuation columns: those wait for the
-- approved costing policy (ADR 005/007). Work orders reconcile materials and quantities.

ALTER TYPE movement_type ADD VALUE IF NOT EXISTS 'production_issue';
ALTER TYPE movement_type ADD VALUE IF NOT EXISTS 'production_return';
ALTER TYPE movement_type ADD VALUE IF NOT EXISTS 'production_output';

-- Quality hold on lots and rolls. A quarantined lot cannot be consumed, sold, transferred or reserved.
ALTER TABLE stock_lots
  ADD COLUMN hold_status text NOT NULL DEFAULT 'released' CHECK (hold_status IN ('released', 'quarantined')),
  ADD COLUMN hold_reason text,
  ADD COLUMN held_by uuid REFERENCES users(id),
  ADD COLUMN held_at timestamptz,
  ADD COLUMN released_by uuid REFERENCES users(id),
  ADD COLUMN released_at timestamptz,
  ADD CONSTRAINT stock_lots_hold_reason CHECK (hold_status = 'released' OR hold_reason IS NOT NULL),
  ADD CONSTRAINT stock_lots_release_other CHECK (released_by IS NULL OR released_by <> held_by);

CREATE TABLE work_centres (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  location_id     uuid NOT NULL REFERENCES locations(id),
  code            text NOT NULL CHECK (code ~ '^[A-Z0-9_-]{2,20}$'),
  name            text NOT NULL,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (location_id, code)
);

-- A BOM version also carries its routing. Once active it never changes; a change is a new version.
CREATE TABLE boms (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES organizations(id),
  output_variant_id  uuid NOT NULL REFERENCES product_variants(id),
  version            int NOT NULL,
  status             text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'retired')),
  output_quantity    numeric(20, 6) NOT NULL CHECK (output_quantity > 0),  -- nominal good output the lines below are quoted for
  expected_yield_bps int NOT NULL DEFAULT 10000 CHECK (expected_yield_bps BETWEEN 1 AND 10000),
  requires_qc        boolean NOT NULL DEFAULT false,
  note               text,
  created_by         uuid NOT NULL REFERENCES users(id),
  approved_by        uuid REFERENCES users(id),
  approved_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, output_variant_id, version),
  CHECK (approved_by IS NULL OR approved_by <> created_by)
);
CREATE UNIQUE INDEX boms_one_active ON boms (organization_id, output_variant_id) WHERE status = 'active';

CREATE TABLE bom_components (
  bom_id     uuid NOT NULL REFERENCES boms(id),
  line_no    int NOT NULL,
  variant_id uuid NOT NULL REFERENCES product_variants(id),
  quantity   numeric(20, 6) NOT NULL CHECK (quantity > 0),     -- per bom.output_quantity, in the component's base unit
  scrap_bps  int NOT NULL DEFAULT 0 CHECK (scrap_bps BETWEEN 0 AND 10000),
  PRIMARY KEY (bom_id, line_no),
  UNIQUE (bom_id, variant_id)
);

CREATE TABLE bom_byproducts (
  bom_id     uuid NOT NULL REFERENCES boms(id),
  line_no    int NOT NULL,
  variant_id uuid NOT NULL REFERENCES product_variants(id),
  quantity   numeric(20, 6) NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (bom_id, line_no),
  UNIQUE (bom_id, variant_id)
);

CREATE TABLE bom_operations (
  bom_id               uuid NOT NULL REFERENCES boms(id),
  op_no                int NOT NULL CHECK (op_no > 0),
  name                 text NOT NULL,
  work_centre_id       uuid NOT NULL REFERENCES work_centres(id),
  setup_minutes        int NOT NULL DEFAULT 0 CHECK (setup_minutes >= 0),
  run_minutes_per_unit numeric(12, 4) NOT NULL DEFAULT 0 CHECK (run_minutes_per_unit >= 0),
  qc_checkpoint        boolean NOT NULL DEFAULT false,
  PRIMARY KEY (bom_id, op_no)
);

CREATE FUNCTION bom_child_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s text;
BEGIN
  SELECT status INTO s FROM boms WHERE id = COALESCE(NEW.bom_id, OLD.bom_id);
  IF s <> 'draft' THEN
    RAISE EXCEPTION 'an approved BOM version is frozen; create a new version';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER bom_components_frozen BEFORE INSERT OR UPDATE OR DELETE ON bom_components FOR EACH ROW EXECUTE FUNCTION bom_child_guard();
CREATE TRIGGER bom_byproducts_frozen BEFORE INSERT OR UPDATE OR DELETE ON bom_byproducts FOR EACH ROW EXECUTE FUNCTION bom_child_guard();
CREATE TRIGGER bom_operations_frozen BEFORE INSERT OR UPDATE OR DELETE ON bom_operations FOR EACH ROW EXECUTE FUNCTION bom_child_guard();

CREATE FUNCTION bom_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'draft' AND (
       NEW.output_variant_id <> OLD.output_variant_id OR NEW.version <> OLD.version OR NEW.output_quantity <> OLD.output_quantity
       OR NEW.expected_yield_bps <> OLD.expected_yield_bps OR NEW.requires_qc <> OLD.requires_qc OR NEW.created_by <> OLD.created_by
       OR (OLD.status = 'retired' AND NEW.status <> 'retired') OR (OLD.status = 'active' AND NEW.status = 'draft')) THEN
    RAISE EXCEPTION 'an approved BOM version is frozen; create a new version';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER boms_frozen BEFORE UPDATE ON boms FOR EACH ROW EXECUTE FUNCTION bom_guard();

CREATE TABLE work_orders (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL REFERENCES organizations(id),
  legal_entity_id      uuid NOT NULL REFERENCES legal_entities(id),
  location_id          uuid NOT NULL REFERENCES locations(id),
  wo_number            text NOT NULL,
  bom_id               uuid NOT NULL REFERENCES boms(id),         -- the frozen version this order runs
  output_variant_id    uuid NOT NULL REFERENCES product_variants(id),
  planned_quantity     numeric(20, 6) NOT NULL CHECK (planned_quantity > 0),
  produced_quantity    numeric(20, 6) NOT NULL DEFAULT 0,
  bom_output_quantity  numeric(20, 6) NOT NULL,
  expected_yield_bps   int NOT NULL,
  requires_qc          boolean NOT NULL,
  status               text NOT NULL DEFAULT 'draft'
                       CHECK (status IN ('draft', 'released', 'in_progress', 'completed', 'closed', 'cancelled')),
  tolerance_bps        int NOT NULL DEFAULT 500 CHECK (tolerance_bps BETWEEN 0 AND 10000),   -- material variance allowed at close
  over_production_bps  int NOT NULL DEFAULT 0 CHECK (over_production_bps BETWEEN 0 AND 5000),
  planned_start        date,
  note                 text,
  variance_reason      text,
  created_by           uuid NOT NULL REFERENCES users(id),
  released_by          uuid REFERENCES users(id),
  released_at          timestamptz,
  completed_at         timestamptz,
  closed_by            uuid REFERENCES users(id),
  closed_at            timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (legal_entity_id, wo_number)
);

CREATE TABLE work_order_components (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_order_id     uuid NOT NULL REFERENCES work_orders(id),
  line_no           int NOT NULL,
  variant_id        uuid NOT NULL REFERENCES product_variants(id),
  required_quantity numeric(20, 6) NOT NULL CHECK (required_quantity > 0),
  issued_quantity   numeric(20, 6) NOT NULL DEFAULT 0,
  returned_quantity numeric(20, 6) NOT NULL DEFAULT 0,
  UNIQUE (work_order_id, line_no),
  CHECK (issued_quantity >= 0 AND returned_quantity >= 0 AND returned_quantity <= issued_quantity)
);

CREATE TABLE work_order_allocations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_order_id  uuid NOT NULL REFERENCES work_orders(id),
  component_id   uuid NOT NULL REFERENCES work_order_components(id),
  lot_id         uuid REFERENCES stock_lots(id),
  quantity       numeric(20, 6) NOT NULL CHECK (quantity > 0),
  issued_quantity numeric(20, 6) NOT NULL DEFAULT 0 CHECK (issued_quantity >= 0 AND issued_quantity <= quantity),
  reservation_id uuid NOT NULL REFERENCES stock_reservations(id)
);

-- Every issue and return, for genealogy and reconciliation.
CREATE TABLE work_order_material_moves (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_order_id    uuid NOT NULL REFERENCES work_orders(id),
  component_id     uuid NOT NULL REFERENCES work_order_components(id),
  lot_id           uuid REFERENCES stock_lots(id),
  kind             text NOT NULL CHECK (kind IN ('issue', 'return')),
  quantity         numeric(20, 6) NOT NULL CHECK (quantity > 0),
  is_exception     boolean NOT NULL DEFAULT false,   -- issued beyond what was reserved
  exception_reason text,
  actor_user_id    uuid NOT NULL REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT is_exception OR exception_reason IS NOT NULL)
);
CREATE INDEX work_order_material_moves_lot_idx ON work_order_material_moves (lot_id);

CREATE TABLE work_order_operations (
  work_order_id      uuid NOT NULL REFERENCES work_orders(id),
  op_no              int NOT NULL,
  name               text NOT NULL,
  work_centre_id     uuid NOT NULL REFERENCES work_centres(id),
  planned_minutes    numeric(14, 2) NOT NULL,
  qc_checkpoint      boolean NOT NULL,
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'done')),
  started_by         uuid REFERENCES users(id),
  started_at         timestamptz,
  completed_by       uuid REFERENCES users(id),
  completed_at       timestamptz,
  completed_quantity numeric(20, 6),
  scrap_quantity     numeric(20, 6) NOT NULL DEFAULT 0,
  actual_minutes     numeric(14, 2),
  PRIMARY KEY (work_order_id, op_no)
);

CREATE TABLE work_order_outputs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_order_id uuid NOT NULL REFERENCES work_orders(id),
  kind          text NOT NULL CHECK (kind IN ('output', 'byproduct')),
  variant_id    uuid NOT NULL REFERENCES product_variants(id),
  lot_id        uuid REFERENCES stock_lots(id),
  quantity      numeric(20, 6) NOT NULL CHECK (quantity > 0),
  actor_user_id uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX work_order_outputs_lot_idx ON work_order_outputs (lot_id);
