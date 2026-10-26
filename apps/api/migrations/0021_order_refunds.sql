-- Refunds on online orders. Asking for a refund and approving it are different people. A card refund is sent back
-- through the payment provider; a bank refund is paid out by hand and recorded with its bank reference.

CREATE TABLE order_refunds (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  order_id      uuid NOT NULL REFERENCES sales_orders(id),
  amount_minor  bigint NOT NULL CHECK (amount_minor > 0),
  reason        text NOT NULL,
  method        text NOT NULL CHECK (method IN ('card', 'bank_transfer')),
  -- the card payment being refunded (card refunds only)
  payment_reference text,
  status        text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'approved', 'processing', 'paid', 'failed', 'rejected')),
  requested_by  uuid NOT NULL REFERENCES users(id),
  decided_by    uuid REFERENCES users(id),
  provider_ref  text,
  payout_ref    text,
  detail        text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  decided_at    timestamptz,
  settled_at    timestamptz,
  CHECK (decided_by IS NULL OR decided_by <> requested_by),
  CHECK (method = 'bank_transfer' OR payment_reference IS NOT NULL)
);
CREATE INDEX order_refunds_order ON order_refunds (order_id, created_at);
CREATE UNIQUE INDEX order_refunds_provider_ref ON order_refunds (provider_ref) WHERE provider_ref IS NOT NULL;

INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p FROM roles r, unnest(ARRAY['orders.refund', 'orders.refund.approve']) AS p WHERE r.key = 'group_admin'
ON CONFLICT DO NOTHING;
