-- Sales orders, step 2 of the Sales build plan: what an order needs to be
-- sent, approved past a credit hold, cancelled, short-closed and amended.
--
--   sales_orders           ten nullable columns: when it was sent for
--                          approval, and who / when / why for a credit
--                          release, a cancellation and a short-close
--   sales_order_lines      hsnCode, copied from the item when saved
--   sales_order_revisions  new: each earlier version of an amended order
--
-- Nothing is dropped and no existing row changes.

-- AlterTable
ALTER TABLE "sales_orders" ADD COLUMN     "cancelReason" TEXT,
ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "cancelledById" TEXT,
ADD COLUMN     "creditReleaseReason" TEXT,
ADD COLUMN     "creditReleasedAt" TIMESTAMP(3),
ADD COLUMN     "creditReleasedById" TEXT,
ADD COLUMN     "sentForApprovalAt" TIMESTAMP(3),
ADD COLUMN     "shortCloseReason" TEXT,
ADD COLUMN     "shortClosedAt" TIMESTAMP(3),
ADD COLUMN     "shortClosedById" TEXT;

-- AlterTable
ALTER TABLE "sales_order_lines" ADD COLUMN     "hsnCode" TEXT;

-- CreateTable
CREATE TABLE "sales_order_revisions" (
    "id" TEXT NOT NULL,
    "soId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "changedById" TEXT NOT NULL,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_order_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sales_order_revisions_soId_version_key" ON "sales_order_revisions"("soId", "version");

-- AddForeignKey
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_creditReleasedById_fkey" FOREIGN KEY ("creditReleasedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_shortClosedById_fkey" FOREIGN KEY ("shortClosedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order_revisions" ADD CONSTRAINT "sales_order_revisions_soId_fkey" FOREIGN KEY ("soId") REFERENCES "sales_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order_revisions" ADD CONSTRAINT "sales_order_revisions_changedById_fkey" FOREIGN KEY ("changedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

