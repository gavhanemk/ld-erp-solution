-- A goods receipt records the delivery it came from.
--
-- Fourteen nullable columns on `grn`, and one foreign key. Additive only:
-- nothing is renamed, nothing is dropped, and no existing row is rewritten.
-- Every receipt already on the system simply has them empty.
--
-- Hand-written rather than generated. The shared database still holds BOM work
-- that this repo's schema does not describe, so `prisma migrate dev` offers to
-- DROP TABLE "bom_line_sizes" and DROP COLUMN "departmentId" to "fix the
-- drift". Applied with `prisma db execute`, which runs the file and never
-- diffs, then recorded with `prisma migrate resolve --applied`.

ALTER TABLE "grn"
  ADD COLUMN "gateEntryNo"         TEXT,
  ADD COLUMN "gateEntryDate"       TIMESTAMP(3),
  ADD COLUMN "challanNo"           TEXT,
  ADD COLUMN "challanDate"         TIMESTAMP(3),
  ADD COLUMN "supplierBillNo"      TEXT,
  ADD COLUMN "supplierInvoiceNo"   TEXT,
  ADD COLUMN "supplierInvoiceDate" TIMESTAMP(3),
  ADD COLUMN "packageCount"        INTEGER,
  ADD COLUMN "driverName"          TEXT,
  ADD COLUMN "formNo"              TEXT,
  ADD COLUMN "clientName"          TEXT,
  ADD COLUMN "orderedBy"           TEXT,
  ADD COLUMN "referenceNo"         TEXT,
  ADD COLUMN "createdById"         TEXT;

-- ON DELETE SET NULL, not CASCADE. A user leaving the mill must not take the
-- goods receipts they recorded with them.
ALTER TABLE "grn"
  ADD CONSTRAINT "grn_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
