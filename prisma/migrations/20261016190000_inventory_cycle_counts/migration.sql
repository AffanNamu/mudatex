CREATE TYPE "CycleCountStatus" AS ENUM ('IN_PROGRESS', 'SUBMITTED', 'CANCELLED');

CREATE TABLE "CycleCountSession" (
  "id" UUID NOT NULL,
  "organizationId" UUID NOT NULL,
  "legalEntityId" UUID NOT NULL,
  "locationId" UUID NOT NULL,
  "createdBy" VARCHAR(160) NOT NULL,
  "status" "CycleCountStatus" NOT NULL DEFAULT 'IN_PROGRESS',
  "idempotencyKey" VARCHAR(160) NOT NULL,
  "submittedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "CycleCountSession_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CycleCountSession_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CycleCountSession_legalEntityId_fkey" FOREIGN KEY ("legalEntityId") REFERENCES "LegalEntity"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CycleCountSession_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "CycleCountSession_idempotencyKey_key" ON "CycleCountSession"("idempotencyKey");
CREATE INDEX "CycleCountSession_organizationId_status_createdAt_idx" ON "CycleCountSession"("organizationId", "status", "createdAt");
CREATE INDEX "CycleCountSession_locationId_status_createdAt_idx" ON "CycleCountSession"("locationId", "status", "createdAt");

CREATE TABLE "CycleCountLine" (
  "id" UUID NOT NULL,
  "sessionId" UUID NOT NULL,
  "productId" UUID NOT NULL,
  "expectedQuantity" DECIMAL(20,6) NOT NULL,
  "countedQuantity" DECIMAL(20,6),
  "countedBy" VARCHAR(160),
  "countedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "CycleCountLine_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CycleCountLine_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "CycleCountSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CycleCountLine_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "CycleCountLine_sessionId_productId_key" ON "CycleCountLine"("sessionId", "productId");
CREATE INDEX "CycleCountLine_productId_sessionId_idx" ON "CycleCountLine"("productId", "sessionId");
