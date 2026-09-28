-- How much of an order a charge usually comes to, as a percentage of the goods.
--
-- One nullable-free column with a default, so every charge type already on the
-- system reads 0 and goes on being typed in by hand exactly as before. Nothing
-- renamed, nothing dropped, no data rewritten.
--
-- This is NOT the GST rate. `defaultGstRate` is the tax charged on the charge;
-- this is the size of the charge itself.

-- AlterTable
ALTER TABLE "charge_types" ADD COLUMN     "percentOfValue" DECIMAL(5,2) NOT NULL DEFAULT 0;
