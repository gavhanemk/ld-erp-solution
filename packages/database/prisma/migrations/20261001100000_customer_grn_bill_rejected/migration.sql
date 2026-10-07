-- Customer receipts: the customer's bill beside their challan, and how much of
-- each line was rejected at the gate. Additive only.

-- AlterTable
ALTER TABLE "customer_grn" ADD COLUMN     "billDate" TIMESTAMP(3),
ADD COLUMN     "billNumber" TEXT;

-- AlterTable
ALTER TABLE "customer_grn_lines" ADD COLUMN     "rejectedQty" DECIMAL(10,3) NOT NULL DEFAULT 0;
