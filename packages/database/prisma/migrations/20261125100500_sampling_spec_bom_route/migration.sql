-- Sampling phase 2: a round's colours x sizes, its own BOM and its making route.
-- Only sample_* tables change. They exist only on the sampling branch, so their
-- rules can be relaxed or tightened here; no shared table gains a column.

-- AlterTable: a material line is the sample BOM's line from the first draft
-- save. A draft line may not have its item yet, and the store is chosen when it
-- is first issued, so both may be empty.
ALTER TABLE "sample_materials" ADD COLUMN "component" TEXT NOT NULL DEFAULT '',
ADD COLUMN "colour" TEXT,
ADD COLUMN "departmentId" TEXT,
ADD COLUMN "qtyPerPiece" DECIMAL(10,4) NOT NULL DEFAULT 0,
ADD COLUMN "wastagePct" DECIMAL(5,2) NOT NULL DEFAULT 0,
ADD COLUMN "requiredOverride" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "overrideReason" TEXT,
ADD COLUMN "source" TEXT NOT NULL DEFAULT 'PURCHASE',
ADD COLUMN "estRate" DECIMAL(10,4),
ADD COLUMN "remarks" TEXT NOT NULL DEFAULT '',
ADD COLUMN "sequence" INTEGER NOT NULL DEFAULT 0,
ALTER COLUMN "itemId" DROP NOT NULL,
ALTER COLUMN "warehouseId" DROP NOT NULL;

-- AlterTable: a step released from a route that names its process.
ALTER TABLE "sample_stages" ADD COLUMN "operationId" TEXT,
ADD COLUMN "kind" "ProcessKind",
ADD COLUMN "departmentId" TEXT,
ADD COLUMN "execution" "StepExecution" NOT NULL DEFAULT 'IN_HOUSE',
ADD COLUMN "contractorId" TEXT,
ADD COLUMN "vendorId" TEXT,
ADD COLUMN "instructions" TEXT;

-- AddForeignKey
ALTER TABLE "sample_materials" ADD CONSTRAINT "sample_materials_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sample_stages" ADD CONSTRAINT "sample_stages_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "operations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sample_stages" ADD CONSTRAINT "sample_stages_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sample_stages" ADD CONSTRAINT "sample_stages_contractorId_fkey" FOREIGN KEY ("contractorId") REFERENCES "contractors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sample_stages" ADD CONSTRAINT "sample_stages_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Lines released before this table had parts and per-piece quantities: their
-- planned quantity was typed, so it stands as typed by hand, and stock the
-- buyer owns is material the buyer sends. Listed in the order they were made.
UPDATE "sample_materials" m
SET "requiredOverride" = true,
    "overrideReason" = 'Planned before the material table',
    "source" = CASE WHEN m."ownership" = 'CUSTOMER_OWNED' THEN 'BUYER_SUPPLIED' ELSE 'PURCHASE' END,
    "sequence" = x.n
FROM (
  SELECT "id", ROW_NUMBER() OVER (PARTITION BY "roundId" ORDER BY "id") AS n
  FROM "sample_materials"
) x
WHERE m."id" = x."id";

-- A draft line can need nothing yet, so the planned quantity may be zero; the
-- rest of the rule stands (issuing past the plan is still refused).
ALTER TABLE sample_materials DROP CONSTRAINT sample_material_nonnegative;
ALTER TABLE sample_materials ADD CONSTRAINT sample_material_nonnegative CHECK (
  "plannedQty">=0 AND "issuedQty">=0 AND "returnedQty">=0 AND "usedQty">=0 AND "wasteQty">=0
  AND "issuedQty"<="plannedQty" AND "returnedQty"+"usedQty"+"wasteQty"<="issuedQty"
);
-- The same sources the API and the screens offer (SAMPLE_MATERIAL_SOURCES in packages/shared),
-- and the stock ownership each one means: what we buy is ours, what the buyer sends is theirs.
ALTER TABLE sample_materials ADD CONSTRAINT sample_material_source CHECK ("source" IN ('PURCHASE','BUYER_SUPPLIED'));
ALTER TABLE sample_materials ADD CONSTRAINT sample_material_source_owner CHECK (
  ("source"='PURCHASE' AND "ownership"='OWNED') OR ("source"='BUYER_SUPPLIED' AND "ownership"='CUSTOMER_OWNED')
);
ALTER TABLE sample_materials ADD CONSTRAINT sample_material_line CHECK (
  "qtyPerPiece">=0 AND "wastagePct" BETWEEN 0 AND 100 AND ("estRate" IS NULL OR "estRate">=0)
);
