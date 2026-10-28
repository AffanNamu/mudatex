-- Collections: chasing overdue balances on trade accounts. Reminders go out once per invoice per stage, and a business
-- that stays overdue past its own limit is put on hold automatically, then released when it has paid up.
ALTER TABLE trade_accounts
  ADD COLUMN hold_after_days int NOT NULL DEFAULT 30 CHECK (hold_after_days BETWEEN 0 AND 365),   -- 0 = never hold automatically
  ADD COLUMN held_automatically boolean NOT NULL DEFAULT false;

CREATE TABLE dunning_notices (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id   uuid NOT NULL REFERENCES sales_orders(id),
  stage      text NOT NULL CHECK (stage IN ('due_soon', 'overdue_1', 'overdue_7', 'overdue_14', 'hold', 'manual')),
  sent_to    text,
  sent_by    uuid REFERENCES users(id),     -- null when the system sent it
  sent_at    timestamptz NOT NULL DEFAULT now()
);
-- Automatic stages happen once per invoice; a person's manual reminder can be repeated.
CREATE UNIQUE INDEX dunning_notices_once ON dunning_notices (order_id, stage) WHERE stage <> 'manual';
CREATE INDEX dunning_notices_order ON dunning_notices (order_id, sent_at DESC);
