-- Bill of materials: one BOM per colour, and the department that draws each
-- component from the store.
--
-- The production team makes a BOM for each colourway, because a white shirt and
-- a dusty blue one take different cloth. So the unique key widens from style +
-- version to style + colour + version: White v1.0 and Dusty Blue v1.0 are two
-- BOMs. The old index is dropped only to be replaced; no rows are touched.
--
-- Existing BOMs keep a blank colour. All of them belong to styles offered in
-- more than one colour, so there is no single right answer to fill in, and a
-- guess would be worse than a blank. The screen flags them "Colour not set",
-- and copying one to each colour is how they get one.
--
-- Written by hand for the same reason as 20260916104500: the live database
-- carries columns from an unmerged purchase branch that `migrate dev` would
-- drop. This migration holds only its own five statements.
-- DropIndex
DROP INDEX "bom_styleId_version_key";

-- AlterTable
ALTER TABLE "bom" ADD COLUMN     "color" TEXT;

-- AlterTable
ALTER TABLE "bom_lines" ADD COLUMN     "departmentId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "bom_styleId_color_version_key" ON "bom"("styleId", "color", "version");

-- AddForeignKey
ALTER TABLE "bom_lines" ADD CONSTRAINT "bom_lines_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
