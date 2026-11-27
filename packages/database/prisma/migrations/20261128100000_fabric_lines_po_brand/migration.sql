-- A fabric's own stock lines (27 Nov 2026). The first purchase of a fabric in a
-- design number / colour / in-house brand makes an item under that fabric, so
-- its stock, issues and costs are kept apart from every other design, colour
-- and brand without any stock screen having to ask.
ALTER TABLE "items" ADD COLUMN "parentItemId" TEXT;
ALTER TABLE "items" ADD COLUMN "designNo" TEXT;
ALTER TABLE "items" ADD COLUMN "brandId" TEXT;
ALTER TABLE "items" ADD CONSTRAINT "items_parentItemId_fkey" FOREIGN KEY ("parentItemId") REFERENCES "items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "items" ADD CONSTRAINT "items_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "brands"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "items_parentItemId_idx" ON "items"("parentItemId");
CREATE INDEX "items_brandId_idx" ON "items"("brandId");

-- One stock line per fabric + design + colour + brand, however it is typed.
CREATE UNIQUE INDEX "items_fabric_line_key" ON "items" (
  "parentItemId",
  (COALESCE(lower(btrim("designNo")), '')),
  (COALESCE(lower(btrim("color")), '')),
  (COALESCE("brandId", ''))
) WHERE "parentItemId" IS NOT NULL;

-- The in-house brand a purchase order is for. Optional: blank is a common purchase.
ALTER TABLE "purchase_orders" ADD COLUMN "brandId" TEXT;
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "brands"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "purchase_orders_brandId_idx" ON "purchase_orders"("brandId");
