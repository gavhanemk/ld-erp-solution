-- AlterTable
ALTER TABLE "stock_transfer_lines" ADD COLUMN     "ownerCustomerId" TEXT,
ADD COLUMN     "ownership" "StockOwnership" NOT NULL DEFAULT 'OWNED',
ADD COLUMN     "sizeId" TEXT;

-- AlterTable
ALTER TABLE "stock_adjustments" ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "approvedById" TEXT,
ADD COLUMN     "rejectReason" TEXT,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'APPROVED';

-- AlterTable
ALTER TABLE "stock_adjustment_lines" ADD COLUMN     "ownerCustomerId" TEXT,
ADD COLUMN     "ownership" "StockOwnership" NOT NULL DEFAULT 'OWNED',
ADD COLUMN     "sizeId" TEXT;

-- AlterTable
ALTER TABLE "customer_material_returns" ADD COLUMN     "soId" TEXT;

-- AlterTable
ALTER TABLE "job_work_challans" ADD COLUMN     "moId" TEXT,
ADD COLUMN     "soId" TEXT;

-- AlterTable
ALTER TABLE "job_work_challan_lines" ADD COLUMN     "ownerCustomerId" TEXT,
ADD COLUMN     "ownership" "StockOwnership" NOT NULL DEFAULT 'OWNED',
ADD COLUMN     "sizeId" TEXT;

-- AlterTable
ALTER TABLE "job_work_return_lines" ADD COLUMN     "damagedQty" DECIMAL(10,3) NOT NULL DEFAULT 0;

-- AddForeignKey
ALTER TABLE "stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_ownerCustomerId_fkey" FOREIGN KEY ("ownerCustomerId") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_sizeId_fkey" FOREIGN KEY ("sizeId") REFERENCES "sizes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_adjustments" ADD CONSTRAINT "stock_adjustments_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_adjustment_lines" ADD CONSTRAINT "stock_adjustment_lines_ownerCustomerId_fkey" FOREIGN KEY ("ownerCustomerId") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_adjustment_lines" ADD CONSTRAINT "stock_adjustment_lines_sizeId_fkey" FOREIGN KEY ("sizeId") REFERENCES "sizes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_material_returns" ADD CONSTRAINT "customer_material_returns_soId_fkey" FOREIGN KEY ("soId") REFERENCES "sales_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_work_challans" ADD CONSTRAINT "job_work_challans_soId_fkey" FOREIGN KEY ("soId") REFERENCES "sales_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_work_challans" ADD CONSTRAINT "job_work_challans_moId_fkey" FOREIGN KEY ("moId") REFERENCES "manufacturing_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_work_challan_lines" ADD CONSTRAINT "job_work_challan_lines_ownerCustomerId_fkey" FOREIGN KEY ("ownerCustomerId") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_work_challan_lines" ADD CONSTRAINT "job_work_challan_lines_sizeId_fkey" FOREIGN KEY ("sizeId") REFERENCES "sizes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

