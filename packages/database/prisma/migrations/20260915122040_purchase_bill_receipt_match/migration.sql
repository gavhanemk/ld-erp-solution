-- Purchase bills: the receipt link that makes the three-way match possible,
-- the author every write needs for the audit trail, and the guard that stops
-- one supplier invoice being booked twice.

-- AlterTable
ALTER TABLE "purchase_invoice_lines" ADD COLUMN     "grnLineId" TEXT;

-- AlterTable
ALTER TABLE "purchase_invoices" ADD COLUMN     "createdById" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "supplier_payments" ADD COLUMN     "createdById" TEXT NOT NULL;

-- CreateIndex
CREATE INDEX "purchase_invoices_supplierId_idx" ON "purchase_invoices"("supplierId");

-- CreateIndex
CREATE INDEX "purchase_invoices_status_idx" ON "purchase_invoices"("status");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_invoices_supplierId_supplierInvoiceNo_key" ON "purchase_invoices"("supplierId", "supplierInvoiceNo");

-- CreateIndex
CREATE INDEX "supplier_payments_supplierId_idx" ON "supplier_payments"("supplierId");

-- AddForeignKey
ALTER TABLE "purchase_invoices" ADD CONSTRAINT "purchase_invoices_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_invoice_lines" ADD CONSTRAINT "purchase_invoice_lines_grnLineId_fkey" FOREIGN KEY ("grnLineId") REFERENCES "grn_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

