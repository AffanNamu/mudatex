-- Customers ask to return goods from a delivered online order. Staff approve or decline; an approval raises an ordinary
-- refund request (a second person still has to approve the money); when the goods are back, staff say which go back on the shelf.
ALTER TABLE storefronts ADD COLUMN return_window_hours int NOT NULL DEFAULT 48 CHECK (return_window_hours BETWEEN 0 AND 2160);

CREATE TABLE order_returns (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  order_id        uuid NOT NULL REFERENCES sales_orders(id),
  customer_id     uuid NOT NULL REFERENCES customers(id),
  status          text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'approved', 'rejected', 'received', 'cancelled')),
  reason          text NOT NULL CHECK (reason IN ('damaged', 'wrong_item', 'not_wanted', 'other')),
  note            text CHECK (note IS NULL OR length(note) <= 1000),
  decision_note   text,
  decided_by      uuid REFERENCES users(id),
  decided_at      timestamptz,
  refund_minor    bigint NOT NULL DEFAULT 0 CHECK (refund_minor >= 0),
  refund_id       uuid REFERENCES order_refunds(id),
  received_by     uuid REFERENCES users(id),
  received_at     timestamptz,
  client_key      text NOT NULL,
  request_hash    text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id, client_key)
);
CREATE INDEX order_returns_order_idx ON order_returns (order_id);
CREATE INDEX order_returns_open_idx ON order_returns (organization_id) WHERE status = 'requested';

CREATE TABLE order_return_lines (
  return_id  uuid NOT NULL REFERENCES order_returns(id),
  line_no    int NOT NULL,
  quantity   numeric(20, 6) NOT NULL CHECK (quantity > 0),
  restocked  boolean NOT NULL DEFAULT false,
  PRIMARY KEY (return_id, line_no)
);
