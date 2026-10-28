-- Staff can block a customer account (and say why) and lift the block.
ALTER TABLE customers ADD COLUMN blocked_reason text CHECK (blocked_reason IS NULL OR length(blocked_reason) <= 500);
ALTER TABLE customers ADD COLUMN blocked_at timestamptz;
CREATE INDEX customers_org_name_idx ON customers (organization_id, lower(full_name));
