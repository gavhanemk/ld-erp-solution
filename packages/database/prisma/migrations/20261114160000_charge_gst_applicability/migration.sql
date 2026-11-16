-- Separate applicability from the configured classification and price inclusion.
ALTER TABLE "charge_types"
  ADD COLUMN "salesGstApplicability" TEXT NOT NULL DEFAULT 'APPLICABLE',
  ADD COLUMN "purchaseGstApplicability" TEXT NOT NULL DEFAULT 'APPLICABLE';
UPDATE "charge_types" SET "salesGstApplicability" = 'NONE' WHERE "taxTreatment" = 'NON_TAXABLE' OR "salesTaxCategory" IN ('EXEMPT', 'NIL_RATED', 'NON_GST');
UPDATE "charge_types" SET "purchaseGstApplicability" = 'NONE' WHERE "defaultGstMode" = 'NONE' OR "purchaseTaxCategory" IN ('EXEMPT', 'NIL_RATED', 'NON_GST');
-- Historical transaction rows and snapshots are not modified.
