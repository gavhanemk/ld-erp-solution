-- AlterTable
ALTER TABLE "sales_order_lines" ADD COLUMN     "bGradeRate" DECIMAL(12,2);

-- AlterTable
ALTER TABLE "delivery_challan_lines" ADD COLUMN     "grade" TEXT NOT NULL DEFAULT 'A';

-- AlterTable
ALTER TABLE "finished_goods_receipt_lines" ADD COLUMN     "grade" TEXT NOT NULL DEFAULT 'A';

-- AlterTable
ALTER TABLE "stock_ledger" ADD COLUMN     "grade" TEXT NOT NULL DEFAULT 'A';

-- AlterTable
ALTER TABLE "sales_invoice_lines" ADD COLUMN     "grade" TEXT NOT NULL DEFAULT 'A';

