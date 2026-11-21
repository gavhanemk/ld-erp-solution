-- Sampling phase 7: what a sample cost to make. Charges besides material and
-- labour, and the cost sheet frozen when the costs are finalised. Only sample_*
-- tables change; nothing is posted to the books.

-- AlterTable: the finalised cost sheet, with when and by whom.
ALTER TABLE "sample_requests" ADD COLUMN "costSheet" JSONB,
ADD COLUMN "costFinalisedAt" TIMESTAMP(3),
ADD COLUMN "costFinalisedBy" TEXT;

ALTER TABLE sample_requests ADD CONSTRAINT sample_request_cost_final CHECK (
  ("costSheet" IS NULL) = ("costFinalisedAt" IS NULL)
);

-- CreateTable: a sample's other costs.
CREATE TABLE "sample_charges" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "roundId" TEXT,
    "kind" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "billRef" TEXT,
    "chargedOn" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" TIMESTAMP(3),
    "removedBy" TEXT,
    "removeReason" TEXT,

    CONSTRAINT "sample_charges_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sample_charges_requestId_idx" ON "sample_charges"("requestId");

-- AddForeignKey
ALTER TABLE "sample_charges" ADD CONSTRAINT "sample_charges_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "sample_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sample_charges" ADD CONSTRAINT "sample_charges_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "sample_rounds"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE sample_charges ADD CONSTRAINT sample_charge_shape CHECK (
  "kind" IN ('COURIER','TESTING','PATTERN','SETUP','OTHER')
  AND "amount" > 0
  AND ("removedAt" IS NULL) = ("removeReason" IS NULL)
);
