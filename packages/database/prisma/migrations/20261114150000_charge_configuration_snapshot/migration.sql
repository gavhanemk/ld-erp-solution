-- Additive only: no historical document amounts or taxes are changed.
ALTER TYPE "ChargeGstMode" ADD VALUE IF NOT EXISTS 'INHERIT';
ALTER TABLE "charge_types" ALTER COLUMN "taxTreatment" SET DEFAULT 'EXCLUSIVE';
ALTER TABLE "charge_types"
  ADD COLUMN "purchaseTaxTreatment" "ChargeTaxTreatment" NOT NULL DEFAULT 'EXCLUSIVE',
  ADD COLUMN "salesHsnCodeId" TEXT,
  ADD COLUMN "salesTaxCategory" TEXT NOT NULL DEFAULT 'TAXABLE',
  ADD COLUMN "purchaseTaxCategory" TEXT NOT NULL DEFAULT 'TAXABLE',
  ADD COLUMN "taxReviewRequired" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "charge_types" ADD CONSTRAINT "charge_types_salesHsnCodeId_fkey"
  FOREIGN KEY ("salesHsnCodeId") REFERENCES "hsn_codes"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- Existing classifications were implicit. Flag them; do not guess exempt vs nil vs non-GST.
UPDATE "charge_types" SET "taxReviewRequired" = true,
  "salesTaxCategory" = CASE WHEN "taxTreatment" = 'NON_TAXABLE' OR "defaultGstRate" = 0 THEN 'UNSPECIFIED' ELSE 'TAXABLE' END,
  "purchaseTaxCategory" = CASE WHEN "defaultGstMode" = 'NONE' OR "defaultGstRate" = 0 THEN 'UNSPECIFIED' ELSE 'TAXABLE' END;
ALTER TABLE "sales_invoice_charges" ADD COLUMN "taxSnapshot" JSONB;
ALTER TABLE "sales_order_charges" ADD COLUMN "taxSnapshot" JSONB;
ALTER TABLE "sales_quotation_charges" ADD COLUMN "taxSnapshot" JSONB;
ALTER TABLE "purchase_order_charges" ADD COLUMN "taxSnapshot" JSONB;
ALTER TABLE "purchase_invoice_charges" ADD COLUMN "taxSnapshot" JSONB;
