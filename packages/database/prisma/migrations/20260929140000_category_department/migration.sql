-- The department that normally uses what is filed under a category; a new
-- item in the category starts with it. Nullable, cleared if the department
-- goes. No existing row changes here; it is filled in afterwards through the API.

-- AlterTable
ALTER TABLE "item_categories" ADD COLUMN "departmentId" TEXT;

-- CreateIndex
CREATE INDEX "item_categories_departmentId_idx" ON "item_categories"("departmentId");

-- AddForeignKey
ALTER TABLE "item_categories" ADD CONSTRAINT "item_categories_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
