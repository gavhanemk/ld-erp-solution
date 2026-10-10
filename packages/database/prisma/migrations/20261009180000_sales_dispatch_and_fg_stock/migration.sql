-- Sales Phase 2, step 1: finished goods by size, into stock and out on a
-- delivery challan.
--
--   stock_ledger                  sizeId, nullable: a finished garment's size,
--                                 so each size is its own balance. Null for
--                                 fabric, trims and packing, which keeps every
--                                 existing balance exactly as it was.
--   finished_goods_receipts(+lines)  new: packed garments into the
--                                 finished-goods store, by size, valued at the
--                                 approved BOM cost (else the standard rate)
--   delivery_challans             who it goes to, from which store, the
--                                 packing, who made / dispatched / cancelled it
--   delivery_challan_lines        the order line and item it was sent against,
--                                 and a note when more went than was pending
--   delivery_challan_line_sizes   new: pieces by size on a challan line
--   sales_order_line_sizes        deliveredQty, default 0
--
-- Nothing is dropped and no existing row changes. A size that has stock, a
-- receipt or a challan row against it can no longer be deleted.

-- AlterTable
ALTER TABLE "delivery_challans" ADD COLUMN     "cancelReason" TEXT,
ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "cancelledById" TEXT,
ADD COLUMN     "cartons" INTEGER,
ADD COLUMN     "createdById" TEXT,
ADD COLUMN     "customerId" TEXT,
ADD COLUMN     "deliveredAt" TIMESTAMP(3),
ADD COLUMN     "deliveryAddress" TEXT,
ADD COLUMN     "dispatchedAt" TIMESTAMP(3),
ADD COLUMN     "dispatchedById" TEXT,
ADD COLUMN     "packingNote" TEXT,
ADD COLUMN     "warehouseId" TEXT;

-- AlterTable
ALTER TABLE "delivery_challan_lines" ADD COLUMN     "itemId" TEXT,
ADD COLUMN     "overNote" TEXT,
ADD COLUMN     "soLineId" TEXT;

-- AlterTable
ALTER TABLE "stock_ledger" ADD COLUMN     "sizeId" TEXT;

-- AlterTable
ALTER TABLE "sales_order_line_sizes" ADD COLUMN     "deliveredQty" DECIMAL(10,2) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "delivery_challan_line_sizes" (
    "id" TEXT NOT NULL,
    "lineId" TEXT NOT NULL,
    "sizeId" TEXT NOT NULL,
    "qty" DECIMAL(10,2) NOT NULL,

    CONSTRAINT "delivery_challan_line_sizes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finished_goods_receipts" (
    "id" TEXT NOT NULL,
    "fgrNumber" TEXT NOT NULL,
    "receiptDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "warehouseId" TEXT NOT NULL,
    "soId" TEXT,
    "notes" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "cancelledAt" TIMESTAMP(3),
    "cancelledById" TEXT,
    "cancelReason" TEXT,

    CONSTRAINT "finished_goods_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finished_goods_receipt_lines" (
    "id" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "sizeId" TEXT,
    "qty" DECIMAL(10,2) NOT NULL,
    "unitRate" DECIMAL(10,2) NOT NULL,
    "rateSource" TEXT NOT NULL,

    CONSTRAINT "finished_goods_receipt_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "delivery_challan_line_sizes_lineId_sizeId_key" ON "delivery_challan_line_sizes"("lineId", "sizeId");

-- CreateIndex
CREATE UNIQUE INDEX "finished_goods_receipts_fgrNumber_key" ON "finished_goods_receipts"("fgrNumber");

-- CreateIndex
CREATE INDEX "finished_goods_receipts_soId_idx" ON "finished_goods_receipts"("soId");

-- CreateIndex
CREATE INDEX "delivery_challans_soId_idx" ON "delivery_challans"("soId");

-- CreateIndex
CREATE INDEX "delivery_challans_customerId_idx" ON "delivery_challans"("customerId");

-- CreateIndex
CREATE INDEX "delivery_challan_lines_soLineId_idx" ON "delivery_challan_lines"("soLineId");

-- CreateIndex
CREATE INDEX "stock_ledger_itemId_warehouseId_sizeId_idx" ON "stock_ledger"("itemId", "warehouseId", "sizeId");

-- AddForeignKey
ALTER TABLE "delivery_challans" ADD CONSTRAINT "delivery_challans_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_challans" ADD CONSTRAINT "delivery_challans_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_challans" ADD CONSTRAINT "delivery_challans_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_challans" ADD CONSTRAINT "delivery_challans_dispatchedById_fkey" FOREIGN KEY ("dispatchedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_challans" ADD CONSTRAINT "delivery_challans_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_challan_lines" ADD CONSTRAINT "delivery_challan_lines_soLineId_fkey" FOREIGN KEY ("soLineId") REFERENCES "sales_order_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_challan_lines" ADD CONSTRAINT "delivery_challan_lines_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_challan_line_sizes" ADD CONSTRAINT "delivery_challan_line_sizes_lineId_fkey" FOREIGN KEY ("lineId") REFERENCES "delivery_challan_lines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_challan_line_sizes" ADD CONSTRAINT "delivery_challan_line_sizes_sizeId_fkey" FOREIGN KEY ("sizeId") REFERENCES "sizes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finished_goods_receipts" ADD CONSTRAINT "finished_goods_receipts_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finished_goods_receipts" ADD CONSTRAINT "finished_goods_receipts_soId_fkey" FOREIGN KEY ("soId") REFERENCES "sales_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finished_goods_receipts" ADD CONSTRAINT "finished_goods_receipts_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finished_goods_receipts" ADD CONSTRAINT "finished_goods_receipts_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finished_goods_receipt_lines" ADD CONSTRAINT "finished_goods_receipt_lines_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "finished_goods_receipts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finished_goods_receipt_lines" ADD CONSTRAINT "finished_goods_receipt_lines_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finished_goods_receipt_lines" ADD CONSTRAINT "finished_goods_receipt_lines_sizeId_fkey" FOREIGN KEY ("sizeId") REFERENCES "sizes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_ledger" ADD CONSTRAINT "stock_ledger_sizeId_fkey" FOREIGN KEY ("sizeId") REFERENCES "sizes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

