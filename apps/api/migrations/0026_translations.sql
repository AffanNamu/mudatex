-- Shop wording in other languages. English stays in the original columns; a translation is an optional overlay, and a
-- missing one simply shows the English. Also remembers each shopper's language so their emails and notifications match.
CREATE TABLE content_translations (
  storefront_id uuid NOT NULL REFERENCES storefronts(id),
  entity_type   text NOT NULL CHECK (entity_type IN ('store', 'department', 'product')),
  entity_id     uuid NOT NULL,   -- the storefront, department or storefront_product
  lang          text NOT NULL CHECK (lang IN ('fr', 'ha')),
  field         text NOT NULL CHECK (field IN ('tagline', 'name', 'title', 'description')),
  value         text NOT NULL CHECK (length(btrim(value)) > 0),
  updated_by    uuid REFERENCES users(id),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_type, entity_id, lang, field),
  CHECK ((entity_type = 'store' AND field = 'tagline') OR (entity_type = 'department' AND field = 'name') OR (entity_type = 'product' AND field IN ('title', 'description')))
);
CREATE INDEX content_translations_storefront ON content_translations (storefront_id, entity_type);

ALTER TABLE customers ADD COLUMN language text NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'fr', 'ha'));
