-- Charges, a style number, and the "other charges" box on a purchase order.
--
-- Additive only: three ADD COLUMN / CREATE TABLE statements and their keys.
-- Nothing is renamed and nothing is dropped, so pulling this asks nothing of
-- anyone's database and no existing order changes.

-- AlterTable
ALTER TABLE "purchase_orders" ADD COLUMN     "otherCharges" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "purchase_order_lines" ADD COLUMN     "styleId" TEXT;

-- CreateTable
CREATE TABLE "purchase_order_charges" (
    "id" TEXT NOT NULL,
    "poId" TEXT NOT NULL,
    "chargeTypeId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "gstRate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "cgst" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "sgst" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "igst" DECIMAL(12,2) NOT NULL DEFAULT 0,

    CONSTRAINT "purchase_order_charges_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "purchase_order_charges_poId_chargeTypeId_key" ON "purchase_order_charges"("poId", "chargeTypeId");

-- CreateIndex
CREATE INDEX "purchase_order_charges_poId_idx" ON "purchase_order_charges"("poId");

-- AddForeignKey
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_styleId_fkey" FOREIGN KEY ("styleId") REFERENCES "styles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_charges" ADD CONSTRAINT "purchase_order_charges_poId_fkey" FOREIGN KEY ("poId") REFERENCES "purchase_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_charges" ADD CONSTRAINT "purchase_order_charges_chargeTypeId_fkey" FOREIGN KEY ("chargeTypeId") REFERENCES "charge_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
