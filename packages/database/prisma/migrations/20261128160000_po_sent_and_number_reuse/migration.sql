-- When a purchase order was first sent to its supplier (27 Nov 2026). Never
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

-- Orders already in the recycle bin were binned under the earlier rule, where
-- only the newest gave its number back. They follow the new one:
--
-- a draft never sent that kept its number gives it back now, so the next order
-- takes it (restored, it gets it again while no other order has it);
UPDATE "purchase_orders"
SET "poNumber" = "poNumber" || '~released-m' || substr(md5("id"), 1, 8)
WHERE "deletedAt" IS NOT NULL
  AND "status" = 'DRAFT' AND "sentAt" IS NULL AND "approvedAt" IS NULL
  AND "poNumber" NOT LIKE '%~released-%';

-- an order the supplier had that gave its number back takes it again while no
-- other order has it, so that number is never issued twice.
WITH own AS (
  SELECT DISTINCT ON (split_part("poNumber", '~released-', 1))
         "id", split_part("poNumber", '~released-', 1) AS "number"
  FROM "purchase_orders"
  WHERE "deletedAt" IS NOT NULL
    AND ("status" <> 'DRAFT' OR "sentAt" IS NOT NULL OR "approvedAt" IS NOT NULL)
    AND "poNumber" LIKE '%~released-%'
  ORDER BY split_part("poNumber", '~released-', 1), "deletedAt"
)
UPDATE "purchase_orders" po
SET "poNumber" = own."number"
FROM own
WHERE po."id" = own."id"
  AND NOT EXISTS (SELECT 1 FROM "purchase_orders" o WHERE o."poNumber" = own."number");
