-- Sampling phase 4: issuing from the request's own material in the sample store.
-- Only sample_* tables change, and one new table for leftovers closed out.

-- AlterTable: a line not needed after all, with why and who said so.
ALTER TABLE "sample_materials" ADD COLUMN "waivedAt" TIMESTAMP(3),
ADD COLUMN "waivedReason" TEXT,
ADD COLUMN "waivedBy" TEXT;

-- What is issued is now limited by what the request bought and received
-- (its pool, worked out in the service from its orders and receipts), not by
-- the plan: a line may take a little more than planned, with its reason on the
-- event. Everything else in the rule stands.
ALTER TABLE sample_materials DROP CONSTRAINT sample_material_nonnegative;
ALTER TABLE sample_materials ADD CONSTRAINT sample_material_nonnegative CHECK (
  "plannedQty">=0 AND "issuedQty">=0 AND "returnedQty">=0 AND "usedQty">=0 AND "wasteQty">=0
  AND "returnedQty"+"usedQty"+"wasteQty"<="issuedQty"
);

-- CreateTable: what was left of a request's material in a sample store, closed out.
CREATE TABLE "sample_closeouts" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "roundId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "toWarehouseId" TEXT,
    "qty" DECIMAL(10,3) NOT NULL,
    "value" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "reason" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sample_closeouts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sample_closeouts_requestId_idx" ON "sample_closeouts"("requestId");

-- AddForeignKey
ALTER TABLE "sample_closeouts" ADD CONSTRAINT "sample_closeouts_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "sample_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sample_closeouts" ADD CONSTRAINT "sample_closeouts_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "sample_rounds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sample_closeouts" ADD CONSTRAINT "sample_closeouts_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sample_closeouts" ADD CONSTRAINT "sample_closeouts_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sample_closeouts" ADD CONSTRAINT "sample_closeouts_toWarehouseId_fkey" FOREIGN KEY ("toWarehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sample_closeouts" ADD CONSTRAINT "sample_closeouts_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The two ways a leftover is closed, and a quantity that is something.
ALTER TABLE sample_closeouts ADD CONSTRAINT sample_closeout_kind CHECK ("kind" IN ('USED','MOVED'));
ALTER TABLE sample_closeouts ADD CONSTRAINT sample_closeout_line CHECK (
  "qty" > 0 AND "value" >= 0 AND (("kind" = 'MOVED') = ("toWarehouseId" IS NOT NULL))
);
