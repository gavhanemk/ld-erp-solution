-- Lets a purchase note adjust a receipt line directly, for goods rejected at
-- the gate that were never billed and so have no bill line to point at.
--
-- Additive only: a nullable column, its index, and its foreign key. Every
-- note already on file keeps pointing at its bill line exactly as before.

-- AlterTable
ALTER TABLE "purchase_note_lines" ADD COLUMN "grnLineId" TEXT;

-- CreateIndex
CREATE INDEX "purchase_note_lines_grnLineId_idx" ON "purchase_note_lines"("grnLineId");

-- AddForeignKey
ALTER TABLE "purchase_note_lines" ADD CONSTRAINT "purchase_note_lines_grnLineId_fkey" FOREIGN KEY ("grnLineId") REFERENCES "grn_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
