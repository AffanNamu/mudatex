-- Dashboards read recent sales by date; these keep those reads quick as history grows.
CREATE INDEX pos_sales_completed ON pos_sales (organization_id, completed_at) WHERE status = 'completed';
CREATE INDEX sales_orders_placed ON sales_orders (organization_id, placed_at);
