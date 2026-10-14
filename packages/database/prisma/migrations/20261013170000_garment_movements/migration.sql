-- Garments moved by scanning: the challan a piece is on, a write-off waiting
-- for approval, the credit note it came back on. Additive only.

-- AlterEnum
ALTER TYPE "GarmentStatus" ADD VALUE 'SCRAPPED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "GarmentEventType" ADD VALUE 'ON_CHALLAN';
ALTER TYPE "GarmentEventType" ADD VALUE 'OFF_CHALLAN';
ALTER TYPE "GarmentEventType" ADD VALUE 'TRANSFERRED';
ALTER TYPE "GarmentEventType" ADD VALUE 'SCRAP_REQUESTED';
ALTER TYPE "GarmentEventType" ADD VALUE 'SCRAP_REFUSED';
ALTER TYPE "GarmentEventType" ADD VALUE 'SCRAPPED';

-- AlterTable
ALTER TABLE "garments" ADD COLUMN     "adjustmentId" TEXT,
ADD COLUMN     "creditNoteId" TEXT,
ADD COLUMN     "dcId" TEXT;

-- CreateIndex
CREATE INDEX "garments_dcId_idx" ON "garments"("dcId");

-- CreateIndex
CREATE INDEX "garments_adjustmentId_idx" ON "garments"("adjustmentId");

-- AddForeignKey
ALTER TABLE "garments" ADD CONSTRAINT "garments_dcId_fkey" FOREIGN KEY ("dcId") REFERENCES "delivery_challans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

