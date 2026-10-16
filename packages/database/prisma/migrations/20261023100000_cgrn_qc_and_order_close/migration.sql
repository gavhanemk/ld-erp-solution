-- Customer receipts get a QC step between receiving and stock approval; a
-- job-work order says whether our own material on it is billed; closing a
-- job-work order with the customer's material unaccounted for is recorded as
-- a manager's exception. Additive only: no row is changed or deleted, and no
-- stock figure moves. Receipts already posted keep no QC record, as they had
-- none.

-- AlterTable
ALTER TABLE "customer_grn" ADD COLUMN     "inspectedAt" TIMESTAMP(3),
ADD COLUMN     "inspectedById" TEXT;

-- AlterTable
ALTER TABLE "sales_orders" ADD COLUMN     "materialExceptionAt" TIMESTAMP(3),
ADD COLUMN     "materialExceptionById" TEXT,
ADD COLUMN     "materialExceptionReason" TEXT,
ADD COLUMN     "materialExceptionSnapshot" JSONB,
ADD COLUMN     "ownMaterialBilling" TEXT NOT NULL DEFAULT 'IN_JOB_CHARGE';

-- AlterTable
ALTER TABLE "sales_invoice_charges" ADD COLUMN     "ownMaterial" BOOLEAN NOT NULL DEFAULT false;

-- AddForeignKey
ALTER TABLE "customer_grn" ADD CONSTRAINT "customer_grn_inspectedById_fkey" FOREIGN KEY ("inspectedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_materialExceptionById_fkey" FOREIGN KEY ("materialExceptionById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
