-- Delivery by outside companies. Mudatex does not carry parcels; it hands them to a delivery company, follows them and shows
-- the customer where they are. A "carrier" is a delivery company the business works with and how updates arrive from it:
--   manual   staff type the tracking number and, if they like, progress updates
--   webhook  the company (or a tracking service) calls us with updates, signed with a shared secret
--   api      a connector module in the code books parcels and/or asks the company for progress
CREATE TABLE carriers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  key              text NOT NULL CHECK (key ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  name             text NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
  kind             text NOT NULL CHECK (kind IN ('manual', 'webhook', 'api')),
  -- the company's own tracking page, with {ref} where the tracking number goes
  tracking_url     text CHECK (tracking_url IS NULL OR (tracking_url ~ '^https://' AND tracking_url LIKE '%{ref}%')),
  adapter          text CHECK (adapter IS NULL OR adapter ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  -- the company's own wording for a stage (lower case) -> ours, for webhooks and polling
  status_map       jsonb NOT NULL DEFAULT '{}',
  webhook_secret_encrypted text,
  credentials_encrypted    text,
  active           boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, key),
  CHECK (kind <> 'api' OR adapter IS NOT NULL),
  CHECK (kind = 'api' OR adapter IS NULL)
);

-- One parcel per order for now.
CREATE TABLE shipments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  order_id         uuid NOT NULL UNIQUE REFERENCES sales_orders(id),
  carrier_id       uuid REFERENCES carriers(id),
  carrier_name     text NOT NULL,
  tracking_ref     text,
  external_id      text,
  label_url        text,
  status           text NOT NULL DEFAULT 'booked' CHECK (status IN ('booked', 'picked_up', 'in_transit', 'out_for_delivery', 'delivered', 'failed', 'returned', 'cancelled')),
  eta              date,
  last_event_at    timestamptz,
  polled_at        timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
-- A company's tracking number belongs to one parcel, so an update can only ever be about one order.
CREATE UNIQUE INDEX shipments_carrier_ref_idx ON shipments (carrier_id, tracking_ref) WHERE carrier_id IS NOT NULL AND tracking_ref IS NOT NULL;
CREATE INDEX shipments_open_idx ON shipments (polled_at NULLS FIRST) WHERE status NOT IN ('delivered', 'returned', 'cancelled');

CREATE TABLE shipment_events (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shipment_id       uuid NOT NULL REFERENCES shipments(id),
  -- null: a note that does not change the stage (the company used a word we do not know)
  status            text CHECK (status IN ('booked', 'picked_up', 'in_transit', 'out_for_delivery', 'delivered', 'failed', 'returned', 'cancelled')),
  description       text,
  location          text,
  occurred_at       timestamptz NOT NULL,
  source            text NOT NULL CHECK (source IN ('staff', 'webhook', 'poll', 'system')),
  external_event_id text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shipment_id, external_event_id)
);
CREATE INDEX shipment_events_shipment_idx ON shipment_events (shipment_id, occurred_at);

-- Parcels that were sent before this existed keep what was recorded.
INSERT INTO shipments (organization_id, order_id, carrier_name, tracking_ref, status, last_event_at)
SELECT o.organization_id, o.id, o.carrier, o.tracking_ref, CASE WHEN o.status = 'delivered' THEN 'delivered' ELSE 'in_transit' END, COALESCE(o.delivered_at, o.shipped_at)
  FROM sales_orders o WHERE o.status IN ('shipped', 'delivered') AND o.carrier IS NOT NULL;
