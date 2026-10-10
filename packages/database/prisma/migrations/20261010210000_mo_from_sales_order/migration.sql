-- AlterTable
ALTER TABLE "finished_goods_receipts" ADD COLUMN     "moId" TEXT;

-- AlterTable
ALTER TABLE "manufacturing_orders" ADD COLUMN     "closeReason" TEXT,
ADD COLUMN     "closedAt" TIMESTAMP(3),
ADD COLUMN     "closedById" TEXT;

-- AlterTable
ALTER TABLE "mo_lines" ADD COLUMN     "bomId" TEXT,
ADD COLUMN     "soLineId" TEXT;

-- CreateIndex
CREATE INDEX "mo_lines_soLineId_idx" ON "mo_lines"("soLineId");

-- AddForeignKey
ALTER TABLE "finished_goods_receipts" ADD CONSTRAINT "finished_goods_receipts_moId_fkey" FOREIGN KEY ("moId") REFERENCES "manufacturing_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manufacturing_orders" ADD CONSTRAINT "manufacturing_orders_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mo_lines" ADD CONSTRAINT "mo_lines_soLineId_fkey" FOREIGN KEY ("soLineId") REFERENCES "sales_order_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mo_lines" ADD CONSTRAINT "mo_lines_bomId_fkey" FOREIGN KEY ("bomId") REFERENCES "bom"("id") ON DELETE SET NULL ON UPDATE CASCADE;

