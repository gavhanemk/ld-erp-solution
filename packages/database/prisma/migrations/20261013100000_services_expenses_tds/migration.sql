-- Services & Expenses: TDS rates by date, a usual TDS section on suppliers and
-- expense heads, the TDS section, auto/typed flag and location on a bill, and
-- the service order line a bill line settles. Additive only -- one new table,
-- nullable columns, and one boolean with a default.

-- CreateTable
CREATE TABLE "tds_section_rates" (
    "id" TEXT NOT NULL,
    "sectionId" TEXT NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "rate" DECIMAL(5,2) NOT NULL,
    "noPanRate" DECIMAL(5,2),
    "singleLimit" DECIMAL(12,2),
    "yearlyLimit" DECIMAL(12,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tds_section_rates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tds_section_rates_sectionId_effectiveFrom_key" ON "tds_section_rates"("sectionId", "effectiveFrom");

-- AddForeignKey
ALTER TABLE "tds_section_rates" ADD CONSTRAINT "tds_section_rates_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "tds_sections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Every existing section starts its history at its current rate, from the
-- first day of this financial year. Limits are left empty for accounts to fill.
INSERT INTO "tds_section_rates" ("id", "sectionId", "effectiveFrom", "rate", "updatedAt")
SELECT 'tsr_' || "id", "id", TIMESTAMP '2026-04-01 00:00:00', "rate", CURRENT_TIMESTAMP
FROM "tds_sections";

-- AlterTable
ALTER TABLE "suppliers" ADD COLUMN "tdsSectionId" TEXT;
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_tdsSectionId_fkey" FOREIGN KEY ("tdsSectionId") REFERENCES "tds_sections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "items" ADD COLUMN "tdsSectionId" TEXT;
ALTER TABLE "items" ADD CONSTRAINT "items_tdsSectionId_fkey" FOREIGN KEY ("tdsSectionId") REFERENCES "tds_sections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "purchase_invoices" ADD COLUMN "tdsSectionId" TEXT,
ADD COLUMN "tdsAuto" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "warehouseId" TEXT;
ALTER TABLE "purchase_invoices" ADD CONSTRAINT "purchase_invoices_tdsSectionId_fkey" FOREIGN KEY ("tdsSectionId") REFERENCES "tds_sections"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "purchase_invoices" ADD CONSTRAINT "purchase_invoices_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "purchase_invoice_lines" ADD COLUMN "poLineId" TEXT;
ALTER TABLE "purchase_invoice_lines" ADD CONSTRAINT "purchase_invoice_lines_poLineId_fkey" FOREIGN KEY ("poLineId") REFERENCES "purchase_order_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "purchase_invoice_lines_poLineId_idx" ON "purchase_invoice_lines"("poLineId");
