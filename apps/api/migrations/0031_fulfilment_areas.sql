-- Which shop or warehouse should send an online order. A location "serves" a delivery address when one of its areas
-- matches the address's country and state. The order is sent from the nearest location that has everything; when none has
-- it all, the stock is taken from the serving locations first and then from the rest.
CREATE TABLE fulfilment_areas (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  storefront_id   uuid NOT NULL REFERENCES storefronts(id),
  location_id     uuid NOT NULL REFERENCES locations(id),
  country_code    char(2) NOT NULL,
  -- empty = the whole country; otherwise only these states (lower-case)
  states          text[] NOT NULL DEFAULT '{}',
  -- lower numbers are tried first among locations that serve the same address equally well
  priority        int NOT NULL DEFAULT 100 CHECK (priority BETWEEN 0 AND 10000),
  UNIQUE (storefront_id, location_id, country_code)
);
CREATE INDEX fulfilment_areas_storefront_idx ON fulfilment_areas (storefront_id);
