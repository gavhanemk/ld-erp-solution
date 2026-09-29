-- CreateEnum
CREATE TYPE "PurchaseNoteType" AS ENUM ('DEBIT', 'CREDIT');

-- CreateEnum
CREATE TYPE "PurchaseNoteReason" AS ENUM ('PURCHASE_RETURN', 'SHORT_QUANTITY', 'DAMAGED_MATERIAL', 'QUALITY_REJECTION', 'WRONG_MATERIAL', 'EXCESS_QUANTITY_BILLED', 'RATE_DIFFERENCE', 'EXCESS_BILLING', 'POST_PURCHASE_DISCOUNT', 'OTHER');

-- CreateEnum
CREATE TYPE "PurchaseNoteEffect" AS ENUM ('REDUCES_PAYABLE', 'INCREASES_PAYABLE');

-- CreateEnum
CREATE TYPE "PurchaseNoteStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'POSTED', 'REJECTED', 'CANCELLED');

-- AlterTable
ALTER TABLE "purchase_invoices" ADD COLUMN     "noteAdjustment" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "purchase_notes" (
    "id" TEXT NOT NULL,
    "noteNumber" TEXT NOT NULL,
    "noteType" "PurchaseNoteType" NOT NULL,
    "status" "PurchaseNoteStatus" NOT NULL DEFAULT 'DRAFT',
    "reason" "PurchaseNoteReason" NOT NULL,
    "reasonNote" TEXT,
    "effect" "PurchaseNoteEffect" NOT NULL,
    "supplierId" TEXT NOT NULL,
    "billId" TEXT,
    "withoutBillReason" TEXT,
    "poId" TEXT,
    "grnId" TEXT,
    "noteDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supplierDocNo" TEXT,
    "supplierDocDate" TIMESTAMP(3),
    "warehouseId" TEXT,
    "lrNumber" TEXT,
    "vehicleNo" TEXT,
    "otherRef" TEXT,
    "isIntraState" BOOLEAN NOT NULL DEFAULT true,
    "taxableAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "discountAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "cgst" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "sgst" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "igst" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "otherCharges" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "roundOff" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "totalAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "submittedById" TEXT,
    "submittedAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "postedById" TEXT,
    "postedAt" TIMESTAMP(3),
    "closedById" TEXT,
    "closedAt" TIMESTAMP(3),
    "closedReason" TEXT,

    CONSTRAINT "purchase_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_note_lines" (
    "id" TEXT NOT NULL,
    "noteId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "billLineId" TEXT,
    "description" TEXT,
    "hsnCode" TEXT,
    "originalQty" DECIMAL(10,3),
    "originalRate" DECIMAL(10,2),
    "qty" DECIMAL(10,3) NOT NULL,
    "unitPrice" DECIMAL(10,2) NOT NULL,
    "taxableValue" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "gstRate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "cgst" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "sgst" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "igst" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "remarks" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "purchase_note_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_note_attachments" (
    "id" TEXT NOT NULL,
    "noteId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "mimeType" TEXT,
    "sizeBytes" INTEGER NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_note_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "purchase_notes_noteNumber_key" ON "purchase_notes"("noteNumber");

-- CreateIndex
CREATE INDEX "purchase_notes_supplierId_idx" ON "purchase_notes"("supplierId");

-- CreateIndex
CREATE INDEX "purchase_notes_billId_idx" ON "purchase_notes"("billId");

-- CreateIndex
CREATE INDEX "purchase_notes_noteType_status_idx" ON "purchase_notes"("noteType", "status");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_notes_supplierId_supplierDocNo_key" ON "purchase_notes"("supplierId", "supplierDocNo");

-- CreateIndex
CREATE INDEX "purchase_note_lines_noteId_idx" ON "purchase_note_lines"("noteId");

-- CreateIndex
CREATE INDEX "purchase_note_lines_billLineId_idx" ON "purchase_note_lines"("billLineId");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_note_attachments_storagePath_key" ON "purchase_note_attachments"("storagePath");

-- CreateIndex
CREATE INDEX "purchase_note_attachments_noteId_idx" ON "purchase_note_attachments"("noteId");

-- AddForeignKey
ALTER TABLE "purchase_notes" ADD CONSTRAINT "purchase_notes_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_notes" ADD CONSTRAINT "purchase_notes_billId_fkey" FOREIGN KEY ("billId") REFERENCES "purchase_invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_notes" ADD CONSTRAINT "purchase_notes_poId_fkey" FOREIGN KEY ("poId") REFERENCES "purchase_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_notes" ADD CONSTRAINT "purchase_notes_grnId_fkey" FOREIGN KEY ("grnId") REFERENCES "grn"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_notes" ADD CONSTRAINT "purchase_notes_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_notes" ADD CONSTRAINT "purchase_notes_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_notes" ADD CONSTRAINT "purchase_notes_submittedById_fkey" FOREIGN KEY ("submittedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_notes" ADD CONSTRAINT "purchase_notes_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_notes" ADD CONSTRAINT "purchase_notes_postedById_fkey" FOREIGN KEY ("postedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_notes" ADD CONSTRAINT "purchase_notes_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_note_lines" ADD CONSTRAINT "purchase_note_lines_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "purchase_notes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_note_lines" ADD CONSTRAINT "purchase_note_lines_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_note_lines" ADD CONSTRAINT "purchase_note_lines_billLineId_fkey" FOREIGN KEY ("billLineId") REFERENCES "purchase_invoice_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_note_attachments" ADD CONSTRAINT "purchase_note_attachments_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "purchase_notes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_note_attachments" ADD CONSTRAINT "purchase_note_attachments_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─────────────────────────────────────────────────────────────────────────────
-- Numbering for the supplier credit note.
--
-- Its own series rather than the existing "CN", which belongs to the sales
-- credit note: that is an outward document whose numbering has to be unbroken
-- and sequential under Rule 46, and sharing it would punch holes in it from the
-- purchase office. Debit notes keep using "DN", which is already seeded.
--
-- Written for every company that has no SCN series yet, so re-running it is
-- harmless and a database seeded later still gets one.
INSERT INTO "number_series" (
  "id", "companyId", "docType", "prefix", "separator",
  "financialYear", "lastNumber", "padding", "isActive"
)
SELECT
  gen_random_uuid()::text,
  c."id",
  'SCN',
  'SCN',
  '-',
  COALESCE(NULLIF(c."currentFY", ''), '2627'),
  0,
  4,
  true
FROM "company" c
WHERE NOT EXISTS (
  SELECT 1 FROM "number_series" ns
  WHERE ns."companyId" = c."id" AND ns."docType" = 'SCN'
);
