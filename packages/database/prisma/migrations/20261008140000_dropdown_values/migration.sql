-- Masters -> Dropdown Lists: one table for the small lists the mill keeps for
-- itself (return reasons first), and the name of such a reason on a return
-- challan row. Additive only -- a new table and one nullable column.

-- CreateTable
CREATE TABLE "dropdown_values" (
    "id" TEXT NOT NULL,
    "list" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "behavesAs" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dropdown_values_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "dropdown_values_list_label_key" ON "dropdown_values"("list", "label");

-- CreateIndex
CREATE INDEX "dropdown_values_list_isActive_idx" ON "dropdown_values"("list", "isActive");

-- AlterTable
ALTER TABLE "purchase_return_lines" ADD COLUMN "reasonLabel" TEXT;
