-- Stock reservations against requisition lines, and the sales order a requisition is for. Additive only.

-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('ACTIVE', 'CONSUMED', 'RELEASED');

-- AlterTable
ALTER TABLE "material_requisitions" ADD COLUMN     "soId" TEXT;

-- CreateTable
CREATE TABLE "stock_reservations" (
    "id" TEXT NOT NULL,
    "mrId" TEXT NOT NULL,
    "mrLineId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "soId" TEXT,
    "customerId" TEXT,
    "reservedQty" DECIMAL(10,3) NOT NULL,
    "qty" DECIMAL(10,3) NOT NULL,
    "status" "ReservationStatus" NOT NULL DEFAULT 'ACTIVE',
    "notes" TEXT,
    "reservedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "releasedAt" TIMESTAMP(3),
    "releasedById" TEXT,
    "releaseReason" TEXT,

    CONSTRAINT "stock_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "stock_reservations_itemId_warehouseId_status_idx" ON "stock_reservations"("itemId", "warehouseId", "status");

-- CreateIndex
CREATE INDEX "stock_reservations_mrId_idx" ON "stock_reservations"("mrId");

-- CreateIndex
CREATE INDEX "stock_reservations_customerId_idx" ON "stock_reservations"("customerId");

-- CreateIndex
CREATE INDEX "material_requisitions_soId_idx" ON "material_requisitions"("soId");

-- AddForeignKey
ALTER TABLE "material_requisitions" ADD CONSTRAINT "material_requisitions_soId_fkey" FOREIGN KEY ("soId") REFERENCES "sales_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_mrId_fkey" FOREIGN KEY ("mrId") REFERENCES "material_requisitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_mrLineId_fkey" FOREIGN KEY ("mrLineId") REFERENCES "material_requisition_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_soId_fkey" FOREIGN KEY ("soId") REFERENCES "sales_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_reservedById_fkey" FOREIGN KEY ("reservedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_releasedById_fkey" FOREIGN KEY ("releasedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

