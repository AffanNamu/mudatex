-- Transactional outbox, webhook subscriptions and delivery tracking.
-- Delivery is at-least-once: receivers must treat the event id as an idempotency key.

CREATE TABLE domain_events (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  event_type      text NOT NULL,
  aggregate_type  text NOT NULL,
  aggregate_id    text NOT NULL,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_user_id   uuid REFERENCES users(id),
  request_id      text,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  fanned_out_at   timestamptz
);
CREATE INDEX domain_events_unfanned_idx ON domain_events (id) WHERE fanned_out_at IS NULL;
CREATE INDEX domain_events_type_idx ON domain_events (organization_id, event_type, id DESC);

-- Events are facts. The only change allowed is recording that they were fanned out.
CREATE FUNCTION domain_events_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.fanned_out_at IS NULL
     AND (to_jsonb(NEW) - 'fanned_out_at') = (to_jsonb(OLD) - 'fanned_out_at') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'domain events are append-only';
END;
$$;
CREATE TRIGGER domain_events_immutable BEFORE UPDATE OR DELETE ON domain_events FOR EACH ROW EXECUTE FUNCTION domain_events_guard();
CREATE TRIGGER domain_events_no_truncate BEFORE TRUNCATE ON domain_events FOR EACH STATEMENT EXECUTE FUNCTION domain_events_guard();

CREATE TABLE webhook_endpoints (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  url              text NOT NULL,
  description      text,
  event_types      text[] NOT NULL CHECK (cardinality(event_types) BETWEEN 1 AND 50),
  secret_encrypted text NOT NULL,            -- AES-256-GCM, never returned by the API after creation
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'disabled')),
  created_by       uuid NOT NULL REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE event_deliveries (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id         bigint NOT NULL REFERENCES domain_events(id),
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  target_kind      text NOT NULL CHECK (target_kind IN ('webhook', 'internal')),
  target_key       text NOT NULL,            -- webhook endpoint id, or the internal consumer's name
  endpoint_id      uuid REFERENCES webhook_endpoints(id),
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'delivered', 'dead')),
  attempts         int NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  locked_until     timestamptz,
  last_status_code int,
  last_error       text,
  delivered_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, target_kind, target_key)
);
CREATE INDEX event_deliveries_due_idx ON event_deliveries (next_attempt_at) WHERE status IN ('pending', 'sending');
CREATE INDEX event_deliveries_dead_idx ON event_deliveries (organization_id, created_at DESC) WHERE status = 'dead';
