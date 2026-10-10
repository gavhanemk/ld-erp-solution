-- AlterTable
ALTER TABLE "sales_invoices" ADD COLUMN     "tdsAmount" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "payment_receipts" ADD COLUMN     "bankAccountId" TEXT,
ADD COLUMN     "chequeNo" TEXT,
ADD COLUMN     "clearedAt" TIMESTAMP(3),
ADD COLUMN     "createdById" TEXT,
ADD COLUMN     "onAccount" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "reversalReason" TEXT,
ADD COLUMN     "reversedAt" TIMESTAMP(3),
ADD COLUMN     "reversedById" TEXT,
ADD COLUMN     "status" "PaymentStatus" NOT NULL DEFAULT 'POSTED',
ADD COLUMN     "tdsAmount" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "payment_receipt_allocations" (
    "id" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "tdsAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_receipt_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_receipt_attachments" (
    "id" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "mimeType" TEXT,
    "sizeBytes" INTEGER NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_receipt_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payment_receipt_allocations_invoiceId_idx" ON "payment_receipt_allocations"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "payment_receipt_allocations_receiptId_invoiceId_key" ON "payment_receipt_allocations"("receiptId", "invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "payment_receipt_attachments_storagePath_key" ON "payment_receipt_attachments"("storagePath");

-- CreateIndex
CREATE INDEX "payment_receipt_attachments_receiptId_idx" ON "payment_receipt_attachments"("receiptId");

-- CreateIndex
CREATE INDEX "payment_receipts_customerId_idx" ON "payment_receipts"("customerId");

-- AddForeignKey
ALTER TABLE "payment_receipts" ADD CONSTRAINT "payment_receipts_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "bank_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_receipts" ADD CONSTRAINT "payment_receipts_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_receipts" ADD CONSTRAINT "payment_receipts_reversedById_fkey" FOREIGN KEY ("reversedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_receipt_allocations" ADD CONSTRAINT "payment_receipt_allocations_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "payment_receipts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_receipt_allocations" ADD CONSTRAINT "payment_receipt_allocations_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "sales_invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_receipt_attachments" ADD CONSTRAINT "payment_receipt_attachments_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "payment_receipts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_receipt_attachments" ADD CONSTRAINT "payment_receipt_attachments_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

