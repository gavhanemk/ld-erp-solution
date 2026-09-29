-- A requisition can be cancelled, or closed with part of it still unissued
-- because the rest is no longer wanted. Who did it, when, and why. Three
-- nullable columns; no existing row changes.

-- AlterTable
ALTER TABLE "material_requisitions" ADD COLUMN "closeReason" TEXT,
ADD COLUMN "closedAt" TIMESTAMP(3),
ADD COLUMN "closedById" TEXT;

-- AddForeignKey
ALTER TABLE "material_requisitions" ADD CONSTRAINT "material_requisitions_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
