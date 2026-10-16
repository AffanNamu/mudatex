CREATE TYPE "WarehouseTransferStatus" AS ENUM (
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'IN_TRANSIT',
  'PARTIALLY_RECEIVED',
  'RECEIVED',
  'REJECTED',
  'CANCELLED'
);

CREATE TABLE "WarehouseTransfer" (
  "id" UUID NOT NULL,
  "organizationId" UUID NOT NULL,
  "legalEntityId" UUID NOT NULL,
  "sourceLocationId" UUID NOT NULL,
  "destinationLocationId" UUID NOT NULL,
  "status" "WarehouseTransferStatus" NOT NULL DEFAULT 'DRAFT',
  "requestedBy" VARCHAR(160) NOT NULL,
  "approvedBy" VARCHAR(160),
  "dispatchedBy" VARCHAR(160),
  "lastReceivedBy" VARCHAR(160),
  "idempotencyKey" VARCHAR(160) NOT NULL,
  "reason" VARCHAR(500) NOT NULL,
  "rejectionReason" VARCHAR(500),
  "submittedAt" TIMESTAMPTZ(6),
  "approvedAt" TIMESTAMPTZ(6),
  "dispatchedAt" TIMESTAMPTZ(6),
  "receivedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "WarehouseTransfer_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WarehouseTransfer_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "WarehouseTransfer_legalEntityId_fkey" FOREIGN KEY ("legalEntityId") REFERENCES "LegalEntity"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "WarehouseTransfer_sourceLocationId_fkey" FOREIGN KEY ("sourceLocationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "WarehouseTransfer_destinationLocationId_fkey" FOREIGN KEY ("destinationLocationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "WarehouseTransferLine" (
  "id" UUID NOT NULL,
  "transferId" UUID NOT NULL,
  "productId" UUID NOT NULL,
  "quantityRequested" DECIMAL(20,6) NOT NULL,
  "quantityDispatched" DECIMAL(20,6) NOT NULL DEFAULT 0,
  "quantityReceived" DECIMAL(20,6) NOT NULL DEFAULT 0,
  "uomCode" VARCHAR(20) NOT NULL,
  "discrepancyReason" VARCHAR(500),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "WarehouseTransferLine_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WarehouseTransferLine_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "WarehouseTransfer"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "WarehouseTransferLine_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "WarehouseTransferLine_transferId_productId_key" UNIQUE ("transferId", "productId"),
  CONSTRAINT "WarehouseTransferLine_quantityRequested_check" CHECK ("quantityRequested" > 0),
  CONSTRAINT "WarehouseTransferLine_quantityDispatched_check" CHECK ("quantityDispatched" >= 0 AND "quantityDispatched" <= "quantityRequested"),
  CONSTRAINT "WarehouseTransferLine_quantityReceived_check" CHECK ("quantityReceived" >= 0 AND "quantityReceived" <= "quantityDispatched")
);

CREATE UNIQUE INDEX "WarehouseTransfer_idempotencyKey_key" ON "WarehouseTransfer"("idempotencyKey");
CREATE INDEX "WarehouseTransfer_organizationId_status_createdAt_idx" ON "WarehouseTransfer"("organizationId", "status", "createdAt");
CREATE INDEX "WarehouseTransfer_sourceLocationId_status_idx" ON "WarehouseTransfer"("sourceLocationId", "status");
CREATE INDEX "WarehouseTransfer_destinationLocationId_status_idx" ON "WarehouseTransfer"("destinationLocationId", "status");
CREATE INDEX "WarehouseTransferLine_productId_transferId_idx" ON "WarehouseTransferLine"("productId", "transferId");
