CREATE TYPE "StockReservationStatus" AS ENUM ('ACTIVE', 'PARTIALLY_FULFILLED', 'FULFILLED', 'RELEASED', 'EXPIRED');

CREATE TABLE "StockReservation" (
  "id" UUID NOT NULL,
  "organizationId" UUID NOT NULL,
  "legalEntityId" UUID NOT NULL,
  "locationId" UUID NOT NULL,
  "orderReference" VARCHAR(120) NOT NULL,
  "status" "StockReservationStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdBy" VARCHAR(160) NOT NULL,
  "releasedBy" VARCHAR(160),
  "idempotencyKey" VARCHAR(160) NOT NULL,
  "expiresAt" TIMESTAMPTZ(6),
  "releasedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "StockReservation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "StockReservation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "StockReservation_legalEntityId_fkey" FOREIGN KEY ("legalEntityId") REFERENCES "LegalEntity"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "StockReservation_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "StockReservation_idempotencyKey_key" ON "StockReservation"("idempotencyKey");
CREATE INDEX "StockReservation_organizationId_status_createdAt_idx" ON "StockReservation"("organizationId", "status", "createdAt");
CREATE INDEX "StockReservation_locationId_status_expiresAt_idx" ON "StockReservation"("locationId", "status", "expiresAt");
CREATE INDEX "StockReservation_orderReference_organizationId_idx" ON "StockReservation"("orderReference", "organizationId");

CREATE TABLE "StockReservationLine" (
  "id" UUID NOT NULL,
  "reservationId" UUID NOT NULL,
  "productId" UUID NOT NULL,
  "quantityReserved" DECIMAL(20,6) NOT NULL,
  "quantityFulfilled" DECIMAL(20,6) NOT NULL DEFAULT 0,
  "uomCode" VARCHAR(20) NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "StockReservationLine_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "StockReservationLine_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "StockReservation"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "StockReservationLine_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "StockReservationLine_quantityReserved_check" CHECK ("quantityReserved" > 0),
  CONSTRAINT "StockReservationLine_quantityFulfilled_check" CHECK ("quantityFulfilled" >= 0 AND "quantityFulfilled" <= "quantityReserved")
);

CREATE UNIQUE INDEX "StockReservationLine_reservationId_productId_key" ON "StockReservationLine"("reservationId", "productId");
CREATE INDEX "StockReservationLine_productId_reservationId_idx" ON "StockReservationLine"("productId", "reservationId");
