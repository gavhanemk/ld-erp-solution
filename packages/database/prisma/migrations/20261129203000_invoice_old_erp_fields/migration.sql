-- The tax invoice gains what the old ERP's invoice carried (28 Nov 2026).
-- New columns only: invoices already raised keep everything as it was.

-- "Manufacturer of: ..." under the company's name.
ALTER TABLE "company" ADD COLUMN "manufacturerOf" TEXT;

-- LR date; the consignee apart from the buyer; the packages.
ALTER TABLE "sales_invoices" ADD COLUMN "lrDate" TIMESTAMP(3);
ALTER TABLE "sales_invoices" ADD COLUMN "shipToName" TEXT;
ALTER TABLE "sales_invoices" ADD COLUMN "shipToGstin" TEXT;
ALTER TABLE "sales_invoices" ADD COLUMN "shipToState" TEXT;
ALTER TABLE "sales_invoices" ADD COLUMN "shipToStateCode" TEXT;
ALTER TABLE "sales_invoices" ADD COLUMN "bales" INTEGER;
ALTER TABLE "sales_invoices" ADD COLUMN "rolls" INTEGER;
ALTER TABLE "sales_invoices" ADD COLUMN "cartons" INTEGER;

-- Pieces beside a quantity in metres or kilos.
ALTER TABLE "sales_invoice_lines" ADD COLUMN "pcs" DECIMAL(10,2);
