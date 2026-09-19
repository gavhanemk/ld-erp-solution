-- The quotation an order answers, the mill's own reference, and an internal
-- remark that is not printed on the supplier's copy. All optional: every
-- order already on the system predates them.

-- AlterTable
ALTER TABLE "purchase_orders" ADD COLUMN     "enquiryDate" TIMESTAMP(3),
ADD COLUMN     "enquiryNo" TEXT,
ADD COLUMN     "reference" TEXT,
ADD COLUMN     "remark" TEXT;

