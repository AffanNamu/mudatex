-- Product and department photos uploaded by staff. Kept in the database so a new shop needs no outside image service, and so
-- backups include them. The console shrinks each photo on the device before sending; the server checks what arrives.
CREATE TABLE images (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  content_type    text NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  bytes           bytea NOT NULL,
  size_bytes      int NOT NULL CHECK (size_bytes BETWEEN 1 AND 3000000),
  sha256          text NOT NULL,
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, sha256)
);
