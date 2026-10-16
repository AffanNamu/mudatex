-- Initial foundation schema for Mudatex Enterprise Platform.
-- This migration establishes master data and append-only inventory/audit primitives.
-- Business workflows and privileged write APIs are intentionally not included.

CREATE TYPE "LocationType" AS ENUM ('COUNTRY_OFFICE', 'BRANCH', 'WAREHOUSE', 'PRODUCTION_SITE', 'STORE');
CREATE TYPE "ProductStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');
CREATE TYPE "InventoryMovementType" AS ENUM (
  'OPENING_BALANCE', 'RECEIPT', 'SALE', 'RETURN', 'TRANSFER_OUT',
  'TRANSFER_IN', 'PRODUCTION_ISSUE', 'PRODUCTION_OUTPUT', 'ADJUSTMENT', 'SCRAP'
);

CREATE TABLE "Organization" (
  "id" UUID NOT NULL,
  "code" VARCHAR(40) NOT NULL,
  "name" VARCHAR(200) NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Organization_code_key" ON "Organization"("code");

CREATE TABLE "LegalEntity" (
  "id" UUID NOT NULL,
  "organizationId" UUID NOT NULL,
  "code" VARCHAR(40) NOT NULL,
  "name" VARCHAR(200) NOT NULL,
  "countryCode" CHAR(2) NOT NULL,
  "functionalCurrency" CHAR(3) NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "LegalEntity_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "LegalEntity_organizationId_fkey" FOREIGN KEY ("organizationId")
    REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "LegalEntity_organizationId_code_key" ON "LegalEntity"("organizationId", "code");
CREATE INDEX "LegalEntity_countryCode_active_idx" ON "LegalEntity"("countryCode", "active");

CREATE TABLE "Location" (
  "id" UUID NOT NULL,
  "legalEntityId" UUID NOT NULL,
  "parentId" UUID,
  "code" VARCHAR(40) NOT NULL,
  "name" VARCHAR(200) NOT NULL,
  "type" "LocationType" NOT NULL,
  "timezone" VARCHAR(80) NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "Location_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Location_legalEntityId_fkey" FOREIGN KEY ("legalEntityId")
    REFERENCES "LegalEntity"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "Location_parentId_fkey" FOREIGN KEY ("parentId")
    REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "Location_legalEntityId_code_key" ON "Location"("legalEntityId", "code");
CREATE INDEX "Location_legalEntityId_type_active_idx" ON "Location"("legalEntityId", "type", "active");
CREATE INDEX "Location_parentId_idx" ON "Location"("parentId");

CREATE TABLE "UnitOfMeasure" (
  "id" UUID NOT NULL,
  "code" VARCHAR(20) NOT NULL,
  "name" VARCHAR(80) NOT NULL,
  "decimalPlaces" INTEGER NOT NULL DEFAULT 3,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UnitOfMeasure_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "UnitOfMeasure_code_key" ON "UnitOfMeasure"("code");

CREATE TABLE "Product" (
  "id" UUID NOT NULL,
  "legalEntityId" UUID NOT NULL,
  "sku" VARCHAR(80) NOT NULL,
  "name" VARCHAR(240) NOT NULL,
  "description" TEXT,
  "categoryCode" VARCHAR(80),
  "fabricFamily" VARCHAR(100),
  "pattern" VARCHAR(120),
  "colour" VARCHAR(80),
  "widthMm" INTEGER,
  "composition" VARCHAR(200),
  "baseUomId" UUID NOT NULL,
  "status" "ProductStatus" NOT NULL DEFAULT 'DRAFT',
  "lotTracked" BOOLEAN NOT NULL DEFAULT false,
  "rollTracked" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "Product_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Product_legalEntityId_fkey" FOREIGN KEY ("legalEntityId")
    REFERENCES "LegalEntity"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "Product_baseUomId_fkey" FOREIGN KEY ("baseUomId")
    REFERENCES "UnitOfMeasure"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "Product_legalEntityId_sku_key" ON "Product"("legalEntityId", "sku");
CREATE INDEX "Product_legalEntityId_status_name_idx" ON "Product"("legalEntityId", "status", "name");
CREATE INDEX "Product_categoryCode_idx" ON "Product"("categoryCode");

CREATE TABLE "InventoryMovement" (
  "id" UUID NOT NULL,
  "legalEntityId" UUID NOT NULL,
  "locationId" UUID NOT NULL,
  "productId" UUID NOT NULL,
  "movementType" "InventoryMovementType" NOT NULL,
  "quantity" DECIMAL(20,6) NOT NULL,
  "uomCode" VARCHAR(20) NOT NULL,
  "sourceType" VARCHAR(60),
  "sourceId" VARCHAR(120),
  "idempotencyKey" VARCHAR(160) NOT NULL,
  "reason" VARCHAR(500),
  "occurredAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InventoryMovement_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "InventoryMovement_locationId_fkey" FOREIGN KEY ("locationId")
    REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "InventoryMovement_productId_fkey" FOREIGN KEY ("productId")
    REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "InventoryMovement_idempotencyKey_key" ON "InventoryMovement"("idempotencyKey");
CREATE INDEX "InventoryMovement_legalEntityId_locationId_productId_occurredAt_idx"
  ON "InventoryMovement"("legalEntityId", "locationId", "productId", "occurredAt");
CREATE INDEX "InventoryMovement_sourceType_sourceId_idx" ON "InventoryMovement"("sourceType", "sourceId");

CREATE TABLE "AuditEvent" (
  "id" UUID NOT NULL,
  "organizationId" UUID NOT NULL,
  "actorId" VARCHAR(160),
  "action" VARCHAR(120) NOT NULL,
  "entityType" VARCHAR(100) NOT NULL,
  "entityId" VARCHAR(160) NOT NULL,
  "result" VARCHAR(40) NOT NULL,
  "reason" VARCHAR(500),
  "correlationId" VARCHAR(160),
  "metadata" JSONB,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AuditEvent_organizationId_createdAt_idx" ON "AuditEvent"("organizationId", "createdAt");
CREATE INDEX "AuditEvent_entityType_entityId_idx" ON "AuditEvent"("entityType", "entityId");
CREATE INDEX "AuditEvent_actorId_createdAt_idx" ON "AuditEvent"("actorId", "createdAt");

CREATE TABLE "IdempotencyRecord" (
  "id" UUID NOT NULL,
  "scope" VARCHAR(120) NOT NULL,
  "key" VARCHAR(160) NOT NULL,
  "requestHash" VARCHAR(128) NOT NULL,
  "responseStatus" INTEGER,
  "responseBody" JSONB,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMPTZ(6),
  CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "IdempotencyRecord_scope_key_key" ON "IdempotencyRecord"("scope", "key");
CREATE INDEX "IdempotencyRecord_expiresAt_idx" ON "IdempotencyRecord"("expiresAt");
