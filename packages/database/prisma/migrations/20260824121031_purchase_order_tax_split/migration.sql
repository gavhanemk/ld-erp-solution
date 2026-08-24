/*
  Warnings:

  - You are about to drop the column `taxAmount` on the `purchase_orders` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "purchase_order_lines" ADD COLUMN     "description" TEXT,
ADD COLUMN     "discount" DECIMAL(5,2) NOT NULL DEFAULT 0,
ADD COLUMN     "hsnCode" TEXT;

-- AlterTable
ALTER TABLE "purchase_orders" DROP COLUMN "taxAmount",
ADD COLUMN     "cgst" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "deliveryWarehouseId" TEXT,
ADD COLUMN     "discountAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "igst" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "placeOfSupplyCode" TEXT,
ADD COLUMN     "roundOff" DECIMAL(6,2) NOT NULL DEFAULT 0,
ADD COLUMN     "sgst" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "taxableAmount" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_deliveryWarehouseId_fkey" FOREIGN KEY ("deliveryWarehouseId") REFERENCES "warehouses"("id") ON DELETE SET NULL ON UPDATE CASCADE;
