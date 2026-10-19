-- Automatic journal drafting from business events.
-- Rules are configuration owned by finance and are OFF until a legal entity enables them. They only ever create
-- DRAFT journals; a different person still posts them. Inventory, cost of sales and margin legs are not produced:
-- they depend on the costing method (ADR 005), which is undecided.

ALTER TABLE journal_entries DROP CONSTRAINT journal_entries_source_type_check;
ALTER TABLE journal_entries ADD CONSTRAINT journal_entries_source_type_check CHECK (source_type IN ('manual', 'reversal', 'pos_sale', 'pos_return'));
ALTER TABLE journal_entries ADD COLUMN source_id text;
-- One journal per source document: replaying an event can never create a second one.
CREATE UNIQUE INDEX journal_entries_source_idx ON journal_entries (legal_entity_id, source_type, source_id) WHERE source_id IS NOT NULL;
ALTER TABLE journal_entries ADD CONSTRAINT journal_entries_source_pair CHECK ((source_type IN ('pos_sale', 'pos_return')) = (source_id IS NOT NULL));

CREATE TABLE posting_rule_sets (
  legal_entity_id uuid NOT NULL REFERENCES legal_entities(id),
  kind            text NOT NULL CHECK (kind IN ('pos_revenue')),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  enabled         boolean NOT NULL DEFAULT false,
  accounts        jsonb NOT NULL DEFAULT '{}'::jsonb,     -- role -> account id
  updated_by      uuid REFERENCES users(id),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (legal_entity_id, kind)
);

-- What happened to each source document: drafted, or skipped with the reason, so nothing fails silently.
CREATE TABLE posting_log (
  source_type     text NOT NULL,
  source_id       text NOT NULL,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  legal_entity_id uuid NOT NULL REFERENCES legal_entities(id),
  status          text NOT NULL CHECK (status IN ('drafted', 'skipped')),
  reason          text,
  journal_id      uuid REFERENCES journal_entries(id),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_type, source_id)
);
CREATE INDEX posting_log_skipped_idx ON posting_log (organization_id, updated_at DESC) WHERE status = 'skipped';
