-- Packages: merged (retired into another) with the moves that say so, details corrected (EDITED),
-- the opening line a package was labelled from, an item's usual sticker copies, and how an
-- opening line asked its stock to be packed. Additions only (PostgreSQL 12+ for the enum values).
-- AlterEnum
ALTER TYPE "PackageStatus" ADD VALUE 'MERGED';

-- AlterEnum
ALTER TYPE "PackageMoveType" ADD VALUE 'MERGED_INTO';
ALTER TYPE "PackageMoveType" ADD VALUE 'MERGED_FROM';
ALTER TYPE "PackageMoveType" ADD VALUE 'EDITED';

-- AlterTable
ALTER TABLE "items" ADD COLUMN     "labelCopies" INTEGER;

-- AlterTable
ALTER TABLE "opening_stock_lines" ADD COLUMN     "packCount" INTEGER,
ADD COLUMN     "packType" "PackType";

-- AlterTable
ALTER TABLE "stock_packages" ADD COLUMN     "mergedIntoId" TEXT,
ADD COLUMN     "sourceLineId" TEXT;

-- CreateIndex
CREATE INDEX "stock_packages_mergedIntoId_idx" ON "stock_packages"("mergedIntoId");

-- CreateIndex
CREATE INDEX "stock_packages_sourceLineId_idx" ON "stock_packages"("sourceLineId");

-- AddForeignKey
ALTER TABLE "stock_packages" ADD CONSTRAINT "stock_packages_mergedIntoId_fkey" FOREIGN KEY ("mergedIntoId") REFERENCES "stock_packages"("id") ON DELETE SET NULL ON UPDATE CASCADE;
