-- Sampling phase 3: buying for a sample, and a store that keeps it apart.
-- Additive only. Every store already in the masters is GENERAL, and no order line
-- is linked to a sample, so nothing already bought, received or issued changes.

-- CreateEnum
CREATE TYPE "WarehousePurpose" AS ENUM ('GENERAL', 'SAMPLING');

-- AlterTable: what a store is for. A constant default, so existing rows are not rewritten.
ALTER TABLE "warehouses" ADD COLUMN "purpose" "WarehousePurpose" NOT NULL DEFAULT 'GENERAL';

-- AlterTable: the sample BOM line an order line buys for, and why it buys more than that
-- line still needs. Both empty on every existing line.
ALTER TABLE "purchase_order_lines" ADD COLUMN "sampleMaterialId" TEXT,
ADD COLUMN "sampleOverReason" TEXT;

-- CreateIndex
CREATE INDEX "purchase_order_lines_sampleMaterialId_idx" ON "purchase_order_lines"("sampleMaterialId");

-- AddForeignKey: a sample line with an order against it cannot be deleted.
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_sampleMaterialId_fkey" FOREIGN KEY ("sampleMaterialId") REFERENCES "sample_materials"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
