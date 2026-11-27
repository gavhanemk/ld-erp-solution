-- Purchase order numbers and deleting (the user's rules, 27 Nov 2026). New
-- columns only: no existing order, number or count is changed.

-- When an order is first sent to its supplier, from now on. Never cleared: an
-- order put back to Draft after it was sent has still been sent, so it can only
-- be cancelled and its number stays on record. Orders sent before this column
-- existed are known by their status and the activity log instead.
ALTER TABLE "purchase_orders" ADD COLUMN "sentAt" TIMESTAMP(3);

-- An order deleted for good gives its number back when it was the newest: the
-- count steps back to the last number an order still holds, but never to this
-- or below, so numbers skipped in Settings (or left by a change of format)
-- stay skipped.
ALTER TABLE "number_series" ADD COLUMN "reuseFloor" INTEGER NOT NULL DEFAULT 0;
