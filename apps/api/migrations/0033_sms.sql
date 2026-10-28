-- Text messages about an order, for shoppers who ask for them. Off for everyone until they tick the box in their account.
ALTER TABLE customers ADD COLUMN sms_opt_in boolean NOT NULL DEFAULT false;
ALTER TABLE notification_log DROP CONSTRAINT notification_log_channel_check;
ALTER TABLE notification_log ADD CONSTRAINT notification_log_channel_check CHECK (channel IN ('email', 'push', 'sms'));
