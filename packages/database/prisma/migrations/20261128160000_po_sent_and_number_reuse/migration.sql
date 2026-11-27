-- When a purchase order was first sent to its supplier (28 Nov 2026). Never
-- cleared: an order put back to Draft after it was sent has still been sent,
-- so it can only be cancelled, and its number is never given out again.
ALTER TABLE "purchase_orders" ADD COLUMN "sentAt" TIMESTAMP(3);

-- Orders past Draft were sent; so were drafts the activity log shows as sent once.
UPDATE "purchase_orders" SET "sentAt" = "updatedAt" WHERE "status" <> 'DRAFT';
UPDATE "purchase_orders" po
SET "sentAt" = s.first_sent
FROM (
  SELECT "entityId", MIN("createdAt") AS first_sent
  FROM "audit_logs"
  WHERE "entityType" = 'PurchaseOrder' AND "after"->>'status' = 'SENT'
  GROUP BY "entityId"
) s
WHERE po.id = s."entityId" AND po."sentAt" IS NULL;

-- A purchase order takes the lowest free number of its series. Numbers at or
-- below this are never filled again: the series was moved ahead or renamed
-- in Settings, and what it skipped stays skipped.
ALTER TABLE "number_series" ADD COLUMN "reuseFloor" INTEGER NOT NULL DEFAULT 0;
