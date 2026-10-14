-- Individual finished garments with their own QR label, and the switch on a
-- manufacturing order that turns it on. Additive only.

-- CreateEnum
CREATE TYPE "GarmentStatus" AS ENUM ('IN_STOCK', 'PACKED', 'DISPATCHED', 'VOID');

-- CreateEnum
CREATE TYPE "GarmentEventType" AS ENUM ('TAGGED', 'PACKED', 'UNPACKED', 'DISPATCHED', 'RETURNED', 'VOIDED');

-- AlterTable
ALTER TABLE "manufacturing_orders" ADD COLUMN     "tagGarments" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "garments" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "moId" TEXT NOT NULL,
    "moLineId" TEXT,
    "bundleId" TEXT,
    "fgReceiptId" TEXT NOT NULL,
    "fgReceiptLineId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "sizeId" TEXT,
    "grade" TEXT NOT NULL DEFAULT 'A',
    "warehouseId" TEXT NOT NULL,
    "ownership" "StockOwnership" NOT NULL DEFAULT 'OWNED',
    "ownerCustomerId" TEXT,
    "soId" TEXT,
    "status" "GarmentStatus" NOT NULL DEFAULT 'IN_STOCK',
    "printCount" INTEGER NOT NULL DEFAULT 0,
    "lastPrintedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "garments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "garment_events" (
    "id" TEXT NOT NULL,
    "garmentId" TEXT NOT NULL,
    "type" "GarmentEventType" NOT NULL,
    "referenceType" TEXT,
    "referenceId" TEXT,
    "referenceNumber" TEXT,
    "notes" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "garment_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "garments_code_key" ON "garments"("code");

-- CreateIndex
CREATE INDEX "garments_moId_status_idx" ON "garments"("moId", "status");

-- CreateIndex
CREATE INDEX "garments_fgReceiptLineId_idx" ON "garments"("fgReceiptLineId");

-- CreateIndex
CREATE INDEX "garments_itemId_sizeId_warehouseId_status_idx" ON "garments"("itemId", "sizeId", "warehouseId", "status");

-- CreateIndex
CREATE INDEX "garments_bundleId_idx" ON "garments"("bundleId");

-- CreateIndex
CREATE INDEX "garment_events_garmentId_createdAt_idx" ON "garment_events"("garmentId", "createdAt");

-- AddForeignKey
ALTER TABLE "garments" ADD CONSTRAINT "garments_moId_fkey" FOREIGN KEY ("moId") REFERENCES "manufacturing_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "garments" ADD CONSTRAINT "garments_bundleId_fkey" FOREIGN KEY ("bundleId") REFERENCES "production_bundles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "garments" ADD CONSTRAINT "garments_fgReceiptId_fkey" FOREIGN KEY ("fgReceiptId") REFERENCES "finished_goods_receipts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "garments" ADD CONSTRAINT "garments_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "garments" ADD CONSTRAINT "garments_sizeId_fkey" FOREIGN KEY ("sizeId") REFERENCES "sizes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "garments" ADD CONSTRAINT "garments_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "garment_events" ADD CONSTRAINT "garment_events_garmentId_fkey" FOREIGN KEY ("garmentId") REFERENCES "garments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "garment_events" ADD CONSTRAINT "garment_events_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- The running number behind each garment's code: G-00000001, G-00000002, ...
CREATE SEQUENCE IF NOT EXISTS "garment_code_seq";
