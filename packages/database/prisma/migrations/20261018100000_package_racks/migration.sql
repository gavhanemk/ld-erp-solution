-- Rack locations inside a store.
--
-- A package sticker now says where in its store the package sits (B-3). It is
-- set by scanning the sticker onto a rack, or by a stock count done rack by
-- rack, and cleared when the package moves to another store. Additive only:
-- nothing existing changes.

-- AlterEnum
ALTER TYPE "PackageMoveType" ADD VALUE 'RACKED';

-- AlterTable
ALTER TABLE "stock_count_scans" ADD COLUMN     "rack" TEXT;

-- AlterTable
ALTER TABLE "stock_packages" ADD COLUMN     "rack" TEXT;

-- CreateIndex
CREATE INDEX "stock_packages_warehouseId_rack_idx" ON "stock_packages"("warehouseId", "rack");
