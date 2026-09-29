-- Bill of materials: costing and pricing.
--
-- A BOM now carries the whole cost of one garment, not just its material:
-- labour and overhead rows (bom_cost_lines), the cost per piece they add up
-- to, a margin and the selling price it gives. The margin is a share of the
-- selling price — 20% means cost ÷ 0.80 — and the price is rounded up to the
-- rupee, before GST.
--
-- A BOM line can also be marked as supplied by the customer. Most of the
-- mill's work is cut-make-trim on the buyer's own fabric, and costing that
-- fabric as if the mill had bought it overstates every such shirt.
--
-- Existing BOMs: the labour they showed until now was read off their linked
-- routing. Each routing step with a rate is written here as a labour row, so
-- no BOM's labour figure changes; it only becomes visible and editable. Only
-- the demo BOMs have a routing. Cost per piece is filled in as material plus
-- labour, with no overhead.
--
-- Written by hand and applied with `prisma migrate deploy`, as every
-- migration on the shared database is. Additions only: no column is dropped
-- or renamed, so the running app is unaffected until the new code arrives.

-- CreateEnum
CREATE TYPE "BOMCostKind" AS ENUM ('LABOUR', 'OVERHEAD');

-- CreateEnum
CREATE TYPE "BOMCostBasis" AS ENUM ('PER_PIECE', 'PERCENT');

-- AlterTable
ALTER TABLE "bom" ADD COLUMN     "costPerPiece" DECIMAL(10,2),
ADD COLUMN     "marginPercent" DECIMAL(5,2),
ADD COLUMN     "overheadCost" DECIMAL(10,2),
ADD COLUMN     "pricedAt" TIMESTAMP(3),
ADD COLUMN     "pricedById" TEXT,
ADD COLUMN     "sellingPrice" DECIMAL(10,2);

-- AlterTable
ALTER TABLE "bom_lines" ADD COLUMN     "customerSupplied" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "bom_cost_lines" (
    "id" TEXT NOT NULL,
    "bomId" TEXT NOT NULL,
    "kind" "BOMCostKind" NOT NULL,
    "name" TEXT NOT NULL,
    "departmentId" TEXT,
    "basis" "BOMCostBasis" NOT NULL DEFAULT 'PER_PIECE',
    "value" DECIMAL(10,2) NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "bom_cost_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "bom_cost_lines_bomId_idx" ON "bom_cost_lines"("bomId");

-- AddForeignKey
ALTER TABLE "bom" ADD CONSTRAINT "bom_pricedById_fkey" FOREIGN KEY ("pricedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bom_cost_lines" ADD CONSTRAINT "bom_cost_lines_bomId_fkey" FOREIGN KEY ("bomId") REFERENCES "bom"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bom_cost_lines" ADD CONSTRAINT "bom_cost_lines_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Existing BOMs: the routing's rated steps become labour rows. The id is
-- derived from the BOM and the step, so it is stable and needs no extension.
INSERT INTO "bom_cost_lines" ("id", "bomId", "kind", "name", "departmentId", "basis", "value", "amount", "sortOrder")
SELECT
    'bcl' || md5(b."id" || ':' || rs."id"),
    b."id",
    'LABOUR'::"BOMCostKind",
    o."name",
    rs."departmentId",
    'PER_PIECE'::"BOMCostBasis",
    rs."ratePerPiece",
    rs."ratePerPiece",
    rs."sequence"
FROM "bom" b
JOIN "routing_steps" rs ON rs."routingId" = b."routingId"
JOIN "operations" o ON o."id" = rs."operationId"
WHERE rs."ratePerPiece" IS NOT NULL AND rs."ratePerPiece" > 0;

-- Labour is now defined as the sum of those rows.
UPDATE "bom" b
SET "labourCost" = s."total"
FROM (
    SELECT "bomId", SUM("amount") AS "total"
    FROM "bom_cost_lines"
    GROUP BY "bomId"
) s
WHERE s."bomId" = b."id";

-- Cost per piece for every BOM that has a cost at all: material + labour.
UPDATE "bom"
SET "overheadCost" = 0,
    "costPerPiece" = ROUND(COALESCE("totalCost", 0) + COALESCE("labourCost", 0), 2)
WHERE "totalCost" IS NOT NULL OR "labourCost" IS NOT NULL;
