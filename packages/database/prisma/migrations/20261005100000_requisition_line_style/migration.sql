-- The garment style a requisition line is for: the number as typed, and the
-- style master's id when it matches a code. Additive only.

-- AlterTable
ALTER TABLE "material_requisition_lines" ADD COLUMN     "styleId" TEXT,
ADD COLUMN     "styleNo" TEXT;

-- AddForeignKey
ALTER TABLE "material_requisition_lines" ADD CONSTRAINT "material_requisition_lines_styleId_fkey" FOREIGN KEY ("styleId") REFERENCES "styles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
