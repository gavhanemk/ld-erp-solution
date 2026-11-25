-- A charge type's usual purchase GST, so a buyer adding "Transport Charges"
-- to an order or bill starts from what it is always billed as (SAC 9965, or
-- a rate typed once and remembered) instead of retyping it on every document
-- (gap left open by #70, 13 Nov 2026).
--
-- Every charge type already in the master starts MANUAL with no code — the
-- same starting point every row already defaulted to in the form, so nothing
-- already saved reads differently until someone sets a type's usual GST.

-- AlterTable
ALTER TABLE "charge_types" ADD COLUMN     "defaultGstMode" "ChargeGstMode" NOT NULL DEFAULT 'MANUAL',
ADD COLUMN     "defaultHsnCodeId" TEXT;

-- AddForeignKey
ALTER TABLE "charge_types" ADD CONSTRAINT "charge_types_defaultHsnCodeId_fkey" FOREIGN KEY ("defaultHsnCodeId") REFERENCES "hsn_codes"("id") ON DELETE SET NULL ON UPDATE CASCADE;
