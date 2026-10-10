-- AlterTable
ALTER TABLE "sales_invoices" ADD COLUMN     "billingAddress" TEXT,
ADD COLUMN     "cancelReason" TEXT,
ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "cancelledById" TEXT,
ADD COLUMN     "createdById" TEXT,
ADD COLUMN     "dcId" TEXT,
ADD COLUMN     "eWayBillDate" TIMESTAMP(3),
ADD COLUMN     "eWayBillNumber" TEXT,
ADD COLUMN     "lrNumber" TEXT,
ADD COLUMN     "otherCharges" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "shippingAddress" TEXT,
ADD COLUMN     "terms" TEXT,
ADD COLUMN     "transporter" TEXT,
ADD COLUMN     "vehicleNumber" TEXT;

-- AlterTable
ALTER TABLE "sales_invoice_lines" ADD COLUMN     "soLineId" TEXT;

-- CreateIndex
CREATE INDEX "sales_invoices_dcId_idx" ON "sales_invoices"("dcId");

-- CreateIndex
CREATE INDEX "sales_invoice_lines_soLineId_idx" ON "sales_invoice_lines"("soLineId");

-- AddForeignKey
ALTER TABLE "sales_invoices" ADD CONSTRAINT "sales_invoices_dcId_fkey" FOREIGN KEY ("dcId") REFERENCES "delivery_challans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_invoices" ADD CONSTRAINT "sales_invoices_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_invoices" ADD CONSTRAINT "sales_invoices_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_invoice_lines" ADD CONSTRAINT "sales_invoice_lines_soLineId_fkey" FOREIGN KEY ("soLineId") REFERENCES "sales_order_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

