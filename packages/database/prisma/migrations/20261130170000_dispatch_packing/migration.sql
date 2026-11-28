-- Packing on the delivery challan (28 Nov 2026): bale or package numbers,
-- the packing list's reference, and the gross weight in kg. All optional;
-- nothing existing changes, nothing is removed.
ALTER TABLE "delivery_challans" ADD COLUMN "baleNumbers" TEXT;
ALTER TABLE "delivery_challans" ADD COLUMN "packingListRef" TEXT;
ALTER TABLE "delivery_challans" ADD COLUMN "grossWeight" DECIMAL(10,2);
