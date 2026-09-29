-- Purchase enquiry: the step between an indent and a purchase order.
--
-- The mill sends a supplier an enquiry — the old ERP's "provisional PO" —
-- carrying quantities and usually no prices. He answers with a proforma
-- invoice, his own numbered document quoting a rate and how long he will hold
-- it. The purchase order is then raised against that PI's number.
--
-- Additive only. Nothing existing is dropped, no column changes type, and both
-- new columns on `purchase_orders` and `purchase_order_lines` are nullable, so
-- every order already on the system stays exactly as it is and reads as an
-- order that was typed straight in — which is what it was.

-- CreateEnum
CREATE TYPE "PurchaseEnquiryStatus" AS ENUM ('DRAFT', 'SENT', 'QUOTED', 'ORDERED', 'CLOSED');

-- AlterTable
ALTER TABLE "purchase_orders" ADD COLUMN     "enquiryId" TEXT;

-- AlterTable
ALTER TABLE "purchase_order_lines" ADD COLUMN     "enquiryLineId" TEXT;

-- CreateTable
CREATE TABLE "purchase_enquiries" (
    "id" TEXT NOT NULL,
    "enquiryNumber" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "enquiryDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "requiredDate" TIMESTAMP(3),
    "status" "PurchaseEnquiryStatus" NOT NULL DEFAULT 'DRAFT',
    "sentAt" TIMESTAMP(3),
    "piNumber" TEXT,
    "piDate" TIMESTAMP(3),
    "piAmount" DECIMAL(12,2),
    "piValidUntil" TIMESTAMP(3),
    "piReceivedAt" TIMESTAMP(3),
    "placeOfSupplyCode" TEXT,
    "notes" TEXT,
    "terms" TEXT,
    "remark" TEXT,
    "closeReason" TEXT,
    "closedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deletedById" TEXT,

    CONSTRAINT "purchase_enquiries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_enquiry_lines" (
    "id" TEXT NOT NULL,
    "enquiryId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "description" TEXT,
    "hsnCode" TEXT,
    "qty" DECIMAL(10,3) NOT NULL,
    "expectedRate" DECIMAL(10,2),
    "quotedRate" DECIMAL(10,2),
    "gstRate" DECIMAL(5,2),
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "mrLineId" TEXT,

    CONSTRAINT "purchase_enquiry_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_enquiry_attachments" (
    "id" TEXT NOT NULL,
    "enquiryId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "mimeType" TEXT,
    "sizeBytes" INTEGER NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_enquiry_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "purchase_enquiries_enquiryNumber_key" ON "purchase_enquiries"("enquiryNumber");

-- CreateIndex
CREATE INDEX "purchase_enquiries_supplierId_idx" ON "purchase_enquiries"("supplierId");

-- CreateIndex
CREATE INDEX "purchase_enquiries_status_idx" ON "purchase_enquiries"("status");

-- CreateIndex
CREATE INDEX "purchase_enquiries_deletedAt_idx" ON "purchase_enquiries"("deletedAt");

-- CreateIndex
CREATE INDEX "purchase_enquiry_lines_enquiryId_idx" ON "purchase_enquiry_lines"("enquiryId");

-- CreateIndex
CREATE INDEX "purchase_enquiry_lines_mrLineId_idx" ON "purchase_enquiry_lines"("mrLineId");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_enquiry_attachments_storagePath_key" ON "purchase_enquiry_attachments"("storagePath");

-- CreateIndex
CREATE INDEX "purchase_enquiry_attachments_enquiryId_idx" ON "purchase_enquiry_attachments"("enquiryId");

-- CreateIndex
CREATE INDEX "purchase_orders_enquiryId_idx" ON "purchase_orders"("enquiryId");

-- CreateIndex
CREATE INDEX "purchase_order_lines_enquiryLineId_idx" ON "purchase_order_lines"("enquiryLineId");

-- AddForeignKey
ALTER TABLE "purchase_enquiries" ADD CONSTRAINT "purchase_enquiries_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_enquiries" ADD CONSTRAINT "purchase_enquiries_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_enquiry_lines" ADD CONSTRAINT "purchase_enquiry_lines_enquiryId_fkey" FOREIGN KEY ("enquiryId") REFERENCES "purchase_enquiries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_enquiry_lines" ADD CONSTRAINT "purchase_enquiry_lines_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_enquiry_lines" ADD CONSTRAINT "purchase_enquiry_lines_mrLineId_fkey" FOREIGN KEY ("mrLineId") REFERENCES "material_requisition_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_enquiry_attachments" ADD CONSTRAINT "purchase_enquiry_attachments_enquiryId_fkey" FOREIGN KEY ("enquiryId") REFERENCES "purchase_enquiries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_enquiry_attachments" ADD CONSTRAINT "purchase_enquiry_attachments_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_enquiryId_fkey" FOREIGN KEY ("enquiryId") REFERENCES "purchase_enquiries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_enquiryLineId_fkey" FOREIGN KEY ("enquiryLineId") REFERENCES "purchase_enquiry_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Numbering for the new document type.
--
-- `nextDocumentNumber` refuses to issue a number when no series is configured,
-- so without this the first enquiry anybody tries to save fails with
-- NO_NUMBER_SERIES and the feature looks broken on arrival.
--
-- An empty financial year, which is how the rest of the purchase chain is
-- numbered: one running sequence, ENQ-0001 upward. It is the tax invoice that
-- has to restart each April, and an enquiry is not one — it is an internal
-- document that happens to be posted to a supplier.
--
-- Written only where no ENQ series exists yet, so re-running is harmless and a
-- database seeded later still gets one.
INSERT INTO "number_series" (
  "id", "companyId", "docType", "prefix", "separator",
  "financialYear", "lastNumber", "padding", "isActive"
)
SELECT
  gen_random_uuid()::text,
  c."id",
  'ENQ',
  'ENQ',
  '-',
  '',
  0,
  4,
  true
FROM "company" c
WHERE NOT EXISTS (
  SELECT 1 FROM "number_series" ns
  WHERE ns."companyId" = c."id" AND ns."docType" = 'ENQ'
);
