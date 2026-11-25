-- Opening stock controls (25 Nov 2026): an HSN code default on item
-- categories; a line's valuation pending and its stock movement; corrections
-- and reversals asked for and approved; reversed entries.

-- AlterTable
ALTER TABLE "item_categories" ADD COLUMN "hsnCode" TEXT;

-- AlterTable
ALTER TABLE "opening_stock_lines" ADD COLUMN "valuationPending" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "ledgerId" TEXT;

-- Lines already in at nought: their value is still to be set.
UPDATE "opening_stock_lines" SET "valuationPending" = true WHERE "unitRate" = 0 AND "value" = 0;

-- AlterTable
ALTER TABLE "opening_stocks" ADD COLUMN "reversedAt" TIMESTAMP(3),
ADD COLUMN "reversedById" TEXT;

-- AddForeignKey
ALTER TABLE "opening_stocks" ADD CONSTRAINT "opening_stocks_reversedById_fkey" FOREIGN KEY ("reversedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "opening_stock_changes" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "openingStockId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "reason" TEXT NOT NULL,
    "lines" JSONB,
    "requestedById" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,

    CONSTRAINT "opening_stock_changes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "opening_stock_changes_number_key" ON "opening_stock_changes"("number");

-- CreateIndex
CREATE INDEX "opening_stock_changes_openingStockId_idx" ON "opening_stock_changes"("openingStockId");

-- CreateIndex
CREATE INDEX "opening_stock_changes_status_idx" ON "opening_stock_changes"("status");

-- AddForeignKey
ALTER TABLE "opening_stock_changes" ADD CONSTRAINT "opening_stock_changes_openingStockId_fkey" FOREIGN KEY ("openingStockId") REFERENCES "opening_stocks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opening_stock_changes" ADD CONSTRAINT "opening_stock_changes_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opening_stock_changes" ADD CONSTRAINT "opening_stock_changes_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The numbering for correction and reversal requests: OSC-2627-0001.
INSERT INTO "number_series" (
  "id", "companyId", "docType", "prefix", "separator",
  "financialYear", "lastNumber", "padding", "isActive"
)
SELECT
  gen_random_uuid()::text,
  c."id",
  'OSC',
  'OSC',
  '-',
  COALESCE(NULLIF(c."currentFY", ''), '2627'),
  0,
  4,
  true
FROM "company" c
WHERE NOT EXISTS (
  SELECT 1 FROM "number_series" ns
  WHERE ns."companyId" = c."id" AND ns."docType" = 'OSC'
);
