-- A fabric's design number (27 Nov 2026). Fabric items are set up in the Items
-- master one design and colour each — Raw Materials › Fabric asks Design No.
-- and Colour (the existing `color`) — and a purchase order shows both from the
-- item it picks. Stock stays one balance per item, as for everything else.
ALTER TABLE "items" ADD COLUMN "designNo" TEXT;

-- The in-house brand a purchase order is for: a purchase and accounting
-- reference. Optional: blank is a common purchase. No effect on stock yet.
ALTER TABLE "purchase_orders" ADD COLUMN "brandId" TEXT;
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "brands"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "purchase_orders_brandId_idx" ON "purchase_orders"("brandId");
