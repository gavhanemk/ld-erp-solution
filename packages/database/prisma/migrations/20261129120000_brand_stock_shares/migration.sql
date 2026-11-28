-- CreateEnum
CREATE TYPE "ReallocationKind" AS ENUM ('EARMARK', 'MOVE', 'RELEASE', 'AUTO');

-- CreateEnum
CREATE TYPE "ReallocationStatus" AS ENUM ('PENDING', 'POSTED', 'REJECTED', 'CANCELLED', 'REVERSED');

-- AlterEnum
ALTER TYPE "PackageMoveType" ADD VALUE 'EARMARKED';

-- AlterEnum
ALTER TYPE "GarmentEventType" ADD VALUE 'EARMARKED';

-- AlterTable
ALTER TABLE "stock_ledger" ADD COLUMN     "brandId" TEXT;

-- AlterTable
ALTER TABLE "stock_transfer_lines" ADD COLUMN     "brandId" TEXT;

-- AlterTable
ALTER TABLE "stock_reservations" ADD COLUMN     "brandId" TEXT;

-- AlterTable
ALTER TABLE "stock_packages" ADD COLUMN     "brandId" TEXT;

-- AlterTable
ALTER TABLE "garments" ADD COLUMN     "brandId" TEXT;

-- CreateTable
CREATE TABLE "stock_reallocations" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "kind" "ReallocationKind" NOT NULL,
    "status" "ReallocationStatus" NOT NULL DEFAULT 'PENDING',
    "warehouseId" TEXT NOT NULL,
    "fromBrandId" TEXT,
    "toBrandId" TEXT,
    "moId" TEXT,
    "mrId" TEXT,
    "reason" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "selfApproved" BOOLEAN NOT NULL DEFAULT false,
    "overrideReason" TEXT,
    "rejectedById" TEXT,
    "rejectedAt" TIMESTAMP(3),
    "rejectReason" TEXT,
    "postedAt" TIMESTAMP(3),
    "reversedById" TEXT,
    "reversedAt" TIMESTAMP(3),
    "reverseReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stock_reallocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_reallocation_lines" (
    "id" TEXT NOT NULL,
    "reallocationId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "sizeId" TEXT,
    "grade" TEXT NOT NULL DEFAULT 'A',
    "qty" DECIMAL(10,3) NOT NULL,
    "unitRate" DECIMAL(10,2),
    "packageCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "garmentCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "stock_reallocation_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "stock_reallocations_number_key" ON "stock_reallocations"("number");

-- CreateIndex
CREATE INDEX "stock_reallocations_status_idx" ON "stock_reallocations"("status");

-- CreateIndex
CREATE INDEX "stock_reallocations_moId_idx" ON "stock_reallocations"("moId");

-- CreateIndex
CREATE INDEX "stock_reallocations_mrId_idx" ON "stock_reallocations"("mrId");

-- CreateIndex
CREATE INDEX "stock_reallocation_lines_reallocationId_idx" ON "stock_reallocation_lines"("reallocationId");

-- CreateIndex
CREATE INDEX "stock_ledger_itemId_warehouseId_brandId_idx" ON "stock_ledger"("itemId", "warehouseId", "brandId");

-- AddForeignKey
ALTER TABLE "stock_ledger" ADD CONSTRAINT "stock_ledger_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "brands"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "brands"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "brands"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_packages" ADD CONSTRAINT "stock_packages_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "brands"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "garments" ADD CONSTRAINT "garments_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "brands"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_reallocations" ADD CONSTRAINT "stock_reallocations_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_reallocations" ADD CONSTRAINT "stock_reallocations_fromBrandId_fkey" FOREIGN KEY ("fromBrandId") REFERENCES "brands"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_reallocations" ADD CONSTRAINT "stock_reallocations_toBrandId_fkey" FOREIGN KEY ("toBrandId") REFERENCES "brands"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_reallocations" ADD CONSTRAINT "stock_reallocations_moId_fkey" FOREIGN KEY ("moId") REFERENCES "manufacturing_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_reallocations" ADD CONSTRAINT "stock_reallocations_mrId_fkey" FOREIGN KEY ("mrId") REFERENCES "material_requisitions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_reallocations" ADD CONSTRAINT "stock_reallocations_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_reallocations" ADD CONSTRAINT "stock_reallocations_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_reallocations" ADD CONSTRAINT "stock_reallocations_rejectedById_fkey" FOREIGN KEY ("rejectedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_reallocations" ADD CONSTRAINT "stock_reallocations_reversedById_fkey" FOREIGN KEY ("reversedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_reallocation_lines" ADD CONSTRAINT "stock_reallocation_lines_reallocationId_fkey" FOREIGN KEY ("reallocationId") REFERENCES "stock_reallocations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_reallocation_lines" ADD CONSTRAINT "stock_reallocation_lines_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_reallocation_lines" ADD CONSTRAINT "stock_reallocation_lines_sizeId_fkey" FOREIGN KEY ("sizeId") REFERENCES "sizes"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- A customer's material is never a brand's: only our own stock can be earmarked.
ALTER TABLE "stock_ledger" ADD CONSTRAINT "stock_ledger_brand_only_owned" CHECK ("brandId" IS NULL OR "ownership" = 'OWNED');
ALTER TABLE "stock_packages" ADD CONSTRAINT "stock_packages_brand_only_owned" CHECK ("brandId" IS NULL OR "ownership" = 'OWNED');
ALTER TABLE "garments" ADD CONSTRAINT "garments_brand_only_owned" CHECK ("brandId" IS NULL OR "ownership" = 'OWNED');
