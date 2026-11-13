-- Purchase charges (freight, transport, dyeing) say where their GST comes
-- from, and GST on them goes back to being worked out separately and added
-- to the total, never read as already sitting inside the figure typed.
--
-- Between 6 and 13 Nov 2026 every purchase charge was taken as the
-- supplier's final, GST-included figure: whatever rate was sent, the server
-- stored 0 and added nothing on top. That was wrong. A purchase charge is
-- the figure BEFORE GST; its GST is worked out on it and added to the
-- order's or bill's total, the way goods always have been. A charge now
-- carries one of three GST modes:
--
--   HSN     the rate comes from an HSN / SAC code chosen for the charge.
--           The code is kept on the row (hsnCodeId), so what the GST was
--           taken from stays on the record even if the master's entry for
--           that code changes later.
--   MANUAL  a rate typed by hand.
--   NONE    no GST on this charge at all.
--
-- Nothing already saved changes: every charge saved under the old rule has
-- gstRate = 0, which NONE also computes, so an old order or bill reads the
-- same total whether it is reopened or left alone. `gstMode` defaults to
-- NONE for exactly that reason — a column added with a default needs no
-- separate UPDATE to backfill it.
--
-- Safe to run before the code that uses it is deployed: both new columns on
-- both tables are nullable or defaulted, and the deployed code does not read
-- them yet.

-- CreateEnum
CREATE TYPE "ChargeGstMode" AS ENUM ('HSN', 'MANUAL', 'NONE');

-- Order charges.
ALTER TABLE "purchase_order_charges"
  ADD COLUMN "gstMode" "ChargeGstMode" NOT NULL DEFAULT 'NONE',
  ADD COLUMN "hsnCodeId" TEXT;

-- AddForeignKey
ALTER TABLE "purchase_order_charges" ADD CONSTRAINT "purchase_order_charges_hsnCodeId_fkey" FOREIGN KEY ("hsnCodeId") REFERENCES "hsn_codes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Bill charges: the same two columns.
ALTER TABLE "purchase_invoice_charges"
  ADD COLUMN "gstMode" "ChargeGstMode" NOT NULL DEFAULT 'NONE',
  ADD COLUMN "hsnCodeId" TEXT;

-- AddForeignKey
ALTER TABLE "purchase_invoice_charges" ADD CONSTRAINT "purchase_invoice_charges_hsnCodeId_fkey" FOREIGN KEY ("hsnCodeId") REFERENCES "hsn_codes"("id") ON DELETE SET NULL ON UPDATE CASCADE;
