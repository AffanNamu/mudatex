-- Stock counts taken on a phone. A count records what was physically counted and what the books said at the moment of
-- counting; any difference becomes an ordinary pending stock adjustment that a second person approves.
CREATE TABLE stock_counts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  location_id     uuid NOT NULL REFERENCES locations(id),
  counted_by      uuid NOT NULL REFERENCES users(id),
  counted_at      timestamptz NOT NULL,
  note            text,
  adjustment_id   uuid REFERENCES stock_adjustments(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stock_counts_location ON stock_counts (organization_id, location_id, created_at DESC);

CREATE TABLE stock_count_lines (
  count_id   uuid NOT NULL REFERENCES stock_counts(id),
  seq        integer NOT NULL,
  variant_id uuid NOT NULL REFERENCES product_variants(id),
  lot_id     uuid REFERENCES stock_lots(id),
  counted    numeric(20, 6) NOT NULL CHECK (counted >= 0),
  expected   numeric(20, 6) NOT NULL,
  PRIMARY KEY (count_id, seq)
);
