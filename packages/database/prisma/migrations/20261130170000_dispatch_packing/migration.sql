-- The dispatch screen, simplified (28 Nov 2026): the customer's rolls a
-- job-work challan's pieces were made from are no longer typed at dispatch;
-- they are read from production (the roll stickers issued to the order's MO
-- and its cutting). The table that held them by hand goes. It came in with
-- 20261130150000_job_challan_rolls, in the same release, so on the live
-- database it is created and dropped empty.
DROP TABLE IF EXISTS "delivery_challan_rolls";

-- Packing on the challan: bale or package numbers, the packing list's
-- reference, and the gross weight in kg. All optional; nothing existing changes.
ALTER TABLE "delivery_challans" ADD COLUMN "baleNumbers" TEXT;
ALTER TABLE "delivery_challans" ADD COLUMN "packingListRef" TEXT;
ALTER TABLE "delivery_challans" ADD COLUMN "grossWeight" DECIMAL(10,2);
