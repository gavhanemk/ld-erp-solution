-- The department that normally uses an item: fabric to Cutting, thread to
-- Stitching. Optional, and cleared rather than blocked if the department goes.

-- AlterTable
ALTER TABLE "items" ADD COLUMN "departmentId" TEXT;

-- CreateIndex
CREATE INDEX "items_departmentId_idx" ON "items"("departmentId");

-- AddForeignKey
ALTER TABLE "items" ADD CONSTRAINT "items_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
