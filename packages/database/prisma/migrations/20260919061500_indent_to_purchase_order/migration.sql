-- Raising a purchase order from an indent.
--
-- Hand-written, and additive only. `prisma migrate dev` on this branch still
-- wants to drop another team's BOM tables, so nothing here is generated.
-- See MIGRATION-NOTES.md.
--
-- Three changes, none of which touch an existing value:
--   1. A requisition line says whether it is answered off the rack or bought.
--      Every line written before today meant the rack, which is the default.
--   2. A purchase order line may point back at the requisition line it
--      answers. Null on every row that exists, and on most that ever will.
--   3. Two indexes for the lists that read them.

-- 1. Where a requisitioned item is to come from.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'RequisitionFulfilment') THEN
    CREATE TYPE "RequisitionFulfilment" AS ENUM ('FROM_STOCK', 'PURCHASE');
  END IF;
END
$$;

ALTER TABLE "material_requisition_lines"
  ADD COLUMN IF NOT EXISTS "fulfilment" "RequisitionFulfilment" NOT NULL DEFAULT 'FROM_STOCK';

CREATE INDEX IF NOT EXISTS "material_requisition_lines_fulfilment_idx"
  ON "material_requisition_lines" ("fulfilment");

-- 2. The order line remembers the request it answers.
ALTER TABLE "purchase_order_lines"
  ADD COLUMN IF NOT EXISTS "mrLineId" TEXT;

CREATE INDEX IF NOT EXISTS "purchase_order_lines_mrLineId_idx"
  ON "purchase_order_lines" ("mrLineId");

-- ON DELETE SET NULL, not CASCADE. A requisition deleted next year must not
-- take a purchase order's line with it — the goods were bought, the bill was
-- paid, and the order is the record of it. It only loses the thread back to
-- the request.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'purchase_order_lines_mrLineId_fkey'
  ) THEN
    ALTER TABLE "purchase_order_lines"
      ADD CONSTRAINT "purchase_order_lines_mrLineId_fkey"
      FOREIGN KEY ("mrLineId") REFERENCES "material_requisition_lines"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$$;
