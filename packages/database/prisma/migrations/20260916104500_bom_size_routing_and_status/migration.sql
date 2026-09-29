-- Bill of materials: consumption by size, a link to the style routing, and a
-- draft/approved/obsolete lifecycle.
--
-- Written by hand rather than by `prisma migrate dev`. The live database
-- carries a handful of empty tables and columns that no branch defines any
-- more -- purchase_order_attachments, purchase_orders.enquiryNo and friends --
-- left behind when the init migration went in through the Supabase connector.
-- `migrate dev` wants to drop them, and bundling somebody else's cleanup into
-- this migration would be a surprise in a BOM pull request. They are left
-- exactly as they are; clearing them up is its own job.
-- CreateEnum
CREATE TYPE "BOMStatus" AS ENUM ('DRAFT', 'APPROVED', 'OBSOLETE');

-- AlterTable
ALTER TABLE "bom" ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "approvedById" TEXT,
ADD COLUMN     "baseSizeId" TEXT,
ADD COLUMN     "copiedFromId" TEXT,
ADD COLUMN     "labourCost" DECIMAL(10,2),
ADD COLUMN     "routingId" TEXT,
ADD COLUMN     "status" "BOMStatus" NOT NULL DEFAULT 'DRAFT';

-- AlterTable
ALTER TABLE "bom_lines" ADD COLUMN     "component" TEXT;

-- CreateTable
CREATE TABLE "bom_line_sizes" (
    "id" TEXT NOT NULL,
    "bomLineId" TEXT NOT NULL,
    "sizeId" TEXT NOT NULL,
    "qtyPerUnit" DECIMAL(10,4) NOT NULL,
    "effectiveQty" DECIMAL(10,4) NOT NULL,
    "totalCost" DECIMAL(10,4),

    CONSTRAINT "bom_line_sizes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "bom_line_sizes_bomLineId_sizeId_key" ON "bom_line_sizes"("bomLineId", "sizeId");

-- CreateIndex
CREATE INDEX "bom_status_idx" ON "bom"("status");

-- CreateIndex
CREATE INDEX "bom_lines_bomId_idx" ON "bom_lines"("bomId");

-- CreateIndex
CREATE INDEX "bom_lines_componentItemId_idx" ON "bom_lines"("componentItemId");

-- AddForeignKey
ALTER TABLE "bom" ADD CONSTRAINT "bom_routingId_fkey" FOREIGN KEY ("routingId") REFERENCES "routings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bom" ADD CONSTRAINT "bom_baseSizeId_fkey" FOREIGN KEY ("baseSizeId") REFERENCES "sizes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bom" ADD CONSTRAINT "bom_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bom" ADD CONSTRAINT "bom_copiedFromId_fkey" FOREIGN KEY ("copiedFromId") REFERENCES "bom"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bom_line_sizes" ADD CONSTRAINT "bom_line_sizes_bomLineId_fkey" FOREIGN KEY ("bomLineId") REFERENCES "bom_lines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bom_line_sizes" ADD CONSTRAINT "bom_line_sizes_sizeId_fkey" FOREIGN KEY ("sizeId") REFERENCES "sizes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The new column defaults to DRAFT, which would leave every BOM already in
-- use looking like a costing nobody has agreed to. Styles with exactly one
-- active BOM are settled here. Where two are active there is no way to tell
-- which one the floor is working to, so they stay DRAFT for a person to
-- decide -- a guess would be the very ambiguity this column exists to end.
UPDATE "bom" b
SET "status" = 'APPROVED'
WHERE b."isActive"
  AND (
    SELECT count(*) FROM "bom" x
    WHERE x."styleId" = b."styleId" AND x."isActive"
  ) = 1;
