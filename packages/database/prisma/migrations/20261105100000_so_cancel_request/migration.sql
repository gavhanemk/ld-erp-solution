-- A sales order's cancellation can be asked for at any stage and decided
-- later: who asked, when and why. Until it is approved or withdrawn, the
-- order's manufacturing orders are on hold. Nothing existing changes.
ALTER TABLE "sales_orders" ADD COLUMN "cancelRequestedById" TEXT,
ADD COLUMN "cancelRequestedAt" TIMESTAMP(3),
ADD COLUMN "cancelRequestReason" TEXT;

ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_cancelRequestedById_fkey" FOREIGN KEY ("cancelRequestedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
