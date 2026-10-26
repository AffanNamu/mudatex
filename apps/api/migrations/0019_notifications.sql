-- Customer notifications (order emails). One row per message actually sent, so a retried event never sends twice.
CREATE TABLE notification_log (
  event_id   bigint NOT NULL REFERENCES domain_events(id),
  channel    text NOT NULL CHECK (channel IN ('email')),
  recipient  text NOT NULL,
  subject    text NOT NULL,
  sent_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, channel)
);
