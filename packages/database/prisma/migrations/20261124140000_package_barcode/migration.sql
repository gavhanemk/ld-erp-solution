-- AlterTable
ALTER TABLE "stock_packages" ADD COLUMN     "barcode" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "stock_packages_barcode_key" ON "stock_packages"("barcode");

