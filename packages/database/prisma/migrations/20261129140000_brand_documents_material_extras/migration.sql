-- Multi-brand phase 5, part 2: the share each document's stock went into or came from
-- (GRN lines, opening stock lines, FG receipts, challan lines, FG cartons), the challan an
-- automatic reallocation was made for, and extra material approved for an MO. Adds only.

-- CreateEnum
CREATE TYPE "MaterialExtraStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN');

-- AlterTable
ALTER TABLE "delivery_challan_lines" ADD COLUMN     "brandId" TEXT;

-- AlterTable
ALTER TABLE "finished_goods_receipts" ADD COLUMN     "brandId" TEXT;

-- AlterTable
ALTER TABLE "grn_lines" ADD COLUMN     "brandId" TEXT;

-- AlterTable
ALTER TABLE "opening_stock_lines" ADD COLUMN     "brandId" TEXT;

-- AlterTable
ALTER TABLE "fg_cartons" ADD COLUMN     "brandId" TEXT;

-- AlterTable
ALTER TABLE "stock_reallocations" ADD COLUMN     "dcId" TEXT;

-- CreateTable
CREATE TABLE "material_extras" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "moId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "ownership" "StockOwnership" NOT NULL DEFAULT 'OWNED',
    "ownerCustomerId" TEXT,
    "qty" DECIMAL(10,3) NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "MaterialExtraStatus" NOT NULL DEFAULT 'PENDING',
    "requestedById" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "rejectReason" TEXT,
    "selfApproved" BOOLEAN NOT NULL DEFAULT false,
    "overrideReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "material_extras_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "material_extras_number_key" ON "material_extras"("number");

-- CreateIndex
CREATE INDEX "material_extras_moId_itemId_idx" ON "material_extras"("moId", "itemId");

-- CreateIndex
CREATE INDEX "material_extras_status_idx" ON "material_extras"("status");

-- CreateIndex
CREATE INDEX "stock_reallocations_dcId_idx" ON "stock_reallocations"("dcId");

-- AddForeignKey
ALTER TABLE "delivery_challan_lines" ADD CONSTRAINT "delivery_challan_lines_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "brands"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finished_goods_receipts" ADD CONSTRAINT "finished_goods_receipts_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "brands"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grn_lines" ADD CONSTRAINT "grn_lines_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "brands"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opening_stock_lines" ADD CONSTRAINT "opening_stock_lines_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "brands"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fg_cartons" ADD CONSTRAINT "fg_cartons_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "brands"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_reallocations" ADD CONSTRAINT "stock_reallocations_dcId_fkey" FOREIGN KEY ("dcId") REFERENCES "delivery_challans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_extras" ADD CONSTRAINT "material_extras_moId_fkey" FOREIGN KEY ("moId") REFERENCES "manufacturing_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_extras" ADD CONSTRAINT "material_extras_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_extras" ADD CONSTRAINT "material_extras_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_extras" ADD CONSTRAINT "material_extras_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

