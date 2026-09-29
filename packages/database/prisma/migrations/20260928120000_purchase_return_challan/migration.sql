-- Purchase return challans: the outward gate pass for goods going back to a
-- supplier, and the link from a debit note back to the challan it came from.
--
-- Additive only. Two new tables, one new enum, and one nullable column on
-- purchase_notes. Nothing existing is altered or dropped, so every note already
-- on the books reads exactly as it did.
--
-- Written by diffing the schema file against the previous schema file, not
-- against the live database: the live database carries three BOM migrations
-- that exist in no branch, and a diff taken from it drops their columns.

-- CreateEnum
CREATE TYPE "PurchaseReturnStatus" AS ENUM ('DISPATCHED', 'CANCELLED');

-- AlterTable
ALTER TABLE "purchase_notes" ADD COLUMN     "returnId" TEXT;

-- CreateTable
CREATE TABLE "purchase_returns" (
    "id" TEXT NOT NULL,
    "returnNumber" TEXT NOT NULL,
    "status" "PurchaseReturnStatus" NOT NULL DEFAULT 'DISPATCHED',
    "returnDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supplierId" TEXT NOT NULL,
    "billId" TEXT NOT NULL,
    "reason" "PurchaseNoteReason" NOT NULL,
    "reasonNote" TEXT,
    "vehicleNo" TEXT,
    "transporterName" TEXT,
    "lrNumber" TEXT,
    "ewayBillNo" TEXT,
    "driverName" TEXT,
    "remarks" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "cancelledById" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,

    CONSTRAINT "purchase_returns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_return_lines" (
    "id" TEXT NOT NULL,
    "returnId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "billLineId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "qty" DECIMAL(10,3) NOT NULL,
    "unitPrice" DECIMAL(10,2) NOT NULL,
    "gstRate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "remarks" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "purchase_return_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "purchase_returns_returnNumber_key" ON "purchase_returns"("returnNumber");

-- CreateIndex
CREATE INDEX "purchase_returns_supplierId_idx" ON "purchase_returns"("supplierId");

-- CreateIndex
CREATE INDEX "purchase_returns_billId_idx" ON "purchase_returns"("billId");

-- CreateIndex
CREATE INDEX "purchase_returns_status_returnDate_idx" ON "purchase_returns"("status", "returnDate");

-- CreateIndex
CREATE INDEX "purchase_return_lines_returnId_idx" ON "purchase_return_lines"("returnId");

-- CreateIndex
CREATE INDEX "purchase_return_lines_billLineId_idx" ON "purchase_return_lines"("billLineId");

-- CreateIndex
CREATE INDEX "purchase_notes_returnId_idx" ON "purchase_notes"("returnId");

-- AddForeignKey
ALTER TABLE "purchase_notes" ADD CONSTRAINT "purchase_notes_returnId_fkey" FOREIGN KEY ("returnId") REFERENCES "purchase_returns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_billId_fkey" FOREIGN KEY ("billId") REFERENCES "purchase_invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_return_lines" ADD CONSTRAINT "purchase_return_lines_returnId_fkey" FOREIGN KEY ("returnId") REFERENCES "purchase_returns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_return_lines" ADD CONSTRAINT "purchase_return_lines_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_return_lines" ADD CONSTRAINT "purchase_return_lines_billLineId_fkey" FOREIGN KEY ("billLineId") REFERENCES "purchase_invoice_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_return_lines" ADD CONSTRAINT "purchase_return_lines_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Numbering for the new document.
--
-- `nextDocumentNumber` refuses to issue a number when no series is configured,
-- so without this the first challan anybody saves fails with NO_NUMBER_SERIES.
-- An empty financial year, as the rest of the purchase chain is numbered: one
-- running sequence, PRC-0001 upward. Written only where none exists yet, so
-- re-running is harmless.
INSERT INTO "number_series" (
  "id", "companyId", "docType", "prefix", "separator",
  "financialYear", "lastNumber", "padding", "isActive"
)
SELECT
  gen_random_uuid()::text,
  c."id",
  'PRC',
  'PRC',
  '-',
  '',
  0,
  4,
  true
FROM "company" c
WHERE NOT EXISTS (
  SELECT 1 FROM "number_series" ns
  WHERE ns."companyId" = c."id" AND ns."docType" = 'PRC'
);
