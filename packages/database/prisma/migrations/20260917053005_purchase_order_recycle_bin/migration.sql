-- The recycle bin for purchase orders.
--
-- Two nullable columns and an index. Additive: nothing renamed, nothing
-- dropped, no data rewritten. Every order already on the system has a NULL
-- deletedAt, which means "not deleted" — so nothing changes for any of them.
--
-- Deleting an order now marks it here instead of removing the row, and every
-- list outside the bin passes over marked rows. That is what makes restoring
-- possible: the lines, charges and attachments never went anywhere.

-- AlterTable
ALTER TABLE "purchase_orders" ADD COLUMN     "deletedAt" TIMESTAMP(3);
ALTER TABLE "purchase_orders" ADD COLUMN     "deletedById" TEXT;

-- CreateIndex
CREATE INDEX "purchase_orders_deletedAt_idx" ON "purchase_orders"("deletedAt");
