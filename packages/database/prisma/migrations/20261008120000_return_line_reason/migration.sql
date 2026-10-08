-- A reason on each return challan row, so one item can go back for two
-- reasons on one challan (30 damaged, 20 off-shade). Additive only — one
-- nullable column; existing rows keep reading the challan's own reason.

-- AlterTable
ALTER TABLE "purchase_return_lines" ADD COLUMN "reason" "PurchaseNoteReason";
