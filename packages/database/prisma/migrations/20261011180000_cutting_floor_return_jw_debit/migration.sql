-- AlterTable
ALTER TABLE "material_requisition_lines" ADD COLUMN     "returnedQty" DECIMAL(10,3) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "cutting_orders" ADD COLUMN     "createdById" TEXT,
ADD COLUMN     "fabricItemId" TEXT,
ADD COLUMN     "panelItemId" TEXT,
ADD COLUMN     "panelWarehouseId" TEXT;

-- AlterTable
ALTER TABLE "purchase_notes" ADD COLUMN     "jobWorkReturnId" TEXT;

-- AddForeignKey
ALTER TABLE "cutting_orders" ADD CONSTRAINT "cutting_orders_fabricItemId_fkey" FOREIGN KEY ("fabricItemId") REFERENCES "items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cutting_orders" ADD CONSTRAINT "cutting_orders_panelItemId_fkey" FOREIGN KEY ("panelItemId") REFERENCES "items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cutting_orders" ADD CONSTRAINT "cutting_orders_panelWarehouseId_fkey" FOREIGN KEY ("panelWarehouseId") REFERENCES "warehouses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cutting_orders" ADD CONSTRAINT "cutting_orders_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_notes" ADD CONSTRAINT "purchase_notes_jobWorkReturnId_fkey" FOREIGN KEY ("jobWorkReturnId") REFERENCES "job_work_returns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

