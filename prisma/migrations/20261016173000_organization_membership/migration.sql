CREATE TYPE "MembershipRole" AS ENUM ('OWNER', 'ADMIN', 'MANAGER', 'STAFF', 'VIEWER');
CREATE TYPE "MembershipStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

CREATE TABLE "OrganizationMembership" (
  "id" UUID NOT NULL,
  "organizationId" UUID NOT NULL,
  "issuer" VARCHAR(500) NOT NULL,
  "subject" VARCHAR(255) NOT NULL,
  "role" "MembershipRole" NOT NULL DEFAULT 'VIEWER',
  "status" "MembershipStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "OrganizationMembership_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OrganizationMembership_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "OrganizationMembership_organizationId_issuer_subject_key"
  ON "OrganizationMembership"("organizationId", "issuer", "subject");
CREATE INDEX "OrganizationMembership_issuer_subject_status_idx"
  ON "OrganizationMembership"("issuer", "subject", "status");
