-- AlterTable
ALTER TABLE "company" ADD COLUMN     "countryOfOrigin" TEXT DEFAULT 'India',
ADD COLUMN     "customerCare" TEXT,
ADD COLUMN     "gs1NextRef" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "gs1Prefix" TEXT;

-- AlterTable
ALTER TABLE "styles" ADD COLUMN     "composition" TEXT,
ADD COLUMN     "mrp" DECIMAL(10,2),
ADD COLUMN     "washCare" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "retail_barcodes" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "sizeId" TEXT,
    "ean" TEXT NOT NULL,
    "mrp" DECIMAL(10,2),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "retail_barcodes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "retail_barcodes_ean_key" ON "retail_barcodes"("ean");

-- CreateIndex
CREATE UNIQUE INDEX "retail_barcodes_itemId_sizeId_key" ON "retail_barcodes"("itemId", "sizeId");

-- AddForeignKey
ALTER TABLE "retail_barcodes" ADD CONSTRAINT "retail_barcodes_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "retail_barcodes" ADD CONSTRAINT "retail_barcodes_sizeId_fkey" FOREIGN KEY ("sizeId") REFERENCES "sizes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

