CREATE TYPE "StockAdjustmentStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

CREATE TABLE "StockAdjustmentRequest" (
  "id" UUID NOT NULL,
  "organizationId" UUID NOT NULL,
  "legalEntityId" UUID NOT NULL,
  "locationId" UUID NOT NULL,
  "productId" UUID NOT NULL,
  "requestedBy" VARCHAR(160) NOT NULL,
  "reviewedBy" VARCHAR(160),
  "quantityDelta" DECIMAL(20,6) NOT NULL,
  "uomCode" VARCHAR(20) NOT NULL,
  "reason" VARCHAR(500) NOT NULL,
  "status" "StockAdjustmentStatus" NOT NULL DEFAULT 'PENDING',
  "idempotencyKey" VARCHAR(160) NOT NULL,
  "reviewedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "StockAdjustmentRequest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "StockAdjustmentRequest_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "StockAdjustmentRequest_legalEntityId_fkey"
    FOREIGN KEY ("legalEntityId") REFERENCES "LegalEntity"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "StockAdjustmentRequest_locationId_fkey"
    FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "StockAdjustmentRequest_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "StockAdjustmentRequest_idempotencyKey_key" ON "StockAdjustmentRequest"("idempotencyKey");
CREATE INDEX "StockAdjustmentRequest_organizationId_status_createdAt_idx"
  ON "StockAdjustmentRequest"("organizationId", "status", "createdAt");
CREATE INDEX "StockAdjustmentRequest_locationId_productId_status_idx"
  ON "StockAdjustmentRequest"("locationId", "productId", "status");
