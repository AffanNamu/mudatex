-- Rows inserted in one transaction share created_at, and uuids are random, so "ORDER BY created_at, id"
-- returned child rows in arbitrary order. An identity column records insertion order.
ALTER TABLE stock_adjustment_lines     ADD COLUMN seq bigint GENERATED ALWAYS AS IDENTITY;
ALTER TABLE stock_transfer_lines       ADD COLUMN seq bigint GENERATED ALWAYS AS IDENTITY;
ALTER TABLE pos_payments               ADD COLUMN seq bigint GENERATED ALWAYS AS IDENTITY;
ALTER TABLE pos_return_lines           ADD COLUMN seq bigint GENERATED ALWAYS AS IDENTITY;
ALTER TABLE work_order_outputs         ADD COLUMN seq bigint GENERATED ALWAYS AS IDENTITY;
ALTER TABLE work_order_material_moves  ADD COLUMN seq bigint GENERATED ALWAYS AS IDENTITY;
