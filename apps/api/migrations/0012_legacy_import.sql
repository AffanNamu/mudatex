-- Migration from the Sakash (PFB) system.
-- legacy_mappings gives every imported record a stable link back to its source. legacy_documents is a read-only
-- archive of historical documents with customer personal data removed. Exceptions are recorded, never dropped silently.

CREATE TABLE legacy_import_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  source_system   text NOT NULL,
  started_by      uuid NOT NULL REFERENCES users(id),
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  options         jsonb NOT NULL DEFAULT '{}'::jsonb,
  summary         jsonb
);

CREATE TABLE legacy_import_exceptions (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id            uuid NOT NULL REFERENCES legacy_import_runs(id),
  source_collection text NOT NULL,
  source_id         text NOT NULL,
  severity          text NOT NULL CHECK (severity IN ('error', 'warning', 'info')),
  code              text NOT NULL,
  message           text NOT NULL
);
CREATE INDEX legacy_import_exceptions_run_idx ON legacy_import_exceptions (run_id, severity);

CREATE TABLE legacy_mappings (
  organization_id   uuid NOT NULL REFERENCES organizations(id),
  source_system     text NOT NULL,
  source_collection text NOT NULL,
  source_id         text NOT NULL,
  target_type       text NOT NULL CHECK (target_type IN ('product', 'document')),
  target_id         uuid NOT NULL,
  checksum          text NOT NULL,
  meta              jsonb NOT NULL DEFAULT '{}'::jsonb,
  first_run_id      uuid NOT NULL REFERENCES legacy_import_runs(id),
  last_run_id       uuid NOT NULL REFERENCES legacy_import_runs(id),
  PRIMARY KEY (organization_id, source_system, source_collection, source_id)
);
CREATE INDEX legacy_mappings_target_idx ON legacy_mappings (target_id);

CREATE TABLE legacy_documents (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES organizations(id),
  source_system     text NOT NULL,
  source_collection text NOT NULL,
  source_id         text NOT NULL,
  payload           jsonb NOT NULL,                 -- allow-listed fields only
  amount            numeric(20, 4),                 -- the document's headline total, for reconciliation
  source_created_at timestamptz,
  checksum          text NOT NULL,
  run_id            uuid NOT NULL REFERENCES legacy_import_runs(id),
  imported_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, source_system, source_collection, source_id)
);
CREATE INDEX legacy_documents_collection_idx ON legacy_documents (organization_id, source_collection, source_created_at);
