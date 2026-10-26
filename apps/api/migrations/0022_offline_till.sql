-- Offline till: sales made without a connection are sent later, once each, and checked again by the server.

ALTER TABLE pos_sales
  ADD COLUMN offline boolean NOT NULL DEFAULT false,
  ADD COLUMN client_sale_id text,
  ADD COLUMN offline_receipt_no text,
  ADD COLUMN sold_at timestamptz,
  ADD COLUMN offline_variance_minor bigint NOT NULL DEFAULT 0,
  ADD COLUMN synced_at timestamptz;

-- A sale sent twice is created once.
CREATE UNIQUE INDEX pos_sales_client_sale ON pos_sales (organization_id, client_sale_id) WHERE client_sale_id IS NOT NULL;

-- Goods that left the shop but were not on the books at that location when the sale arrived.
CREATE TABLE pos_offline_exceptions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  sale_id       uuid NOT NULL REFERENCES pos_sales(id),
  location_id   uuid NOT NULL REFERENCES locations(id),
  variant_id    uuid NOT NULL REFERENCES product_variants(id),
  quantity_short numeric(20, 6) NOT NULL CHECK (quantity_short > 0),
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  resolved_by   uuid REFERENCES users(id),
  resolved_at   timestamptz,
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pos_offline_exceptions_open ON pos_offline_exceptions (organization_id, status, created_at);
