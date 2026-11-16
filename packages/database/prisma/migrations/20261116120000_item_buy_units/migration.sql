-- Packs an item is bought in besides its own unit (1 Box = 20 pcs), and on each
-- purchase document line the unit it counts in and what one of it holds.
-- Existing lines keep the item's own unit (no unit, factor 1): nothing old changes.

CREATE TABLE "ld_erp"."item_units" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "uomId" TEXT NOT NULL,
    "factor" DECIMAL(12,4) NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "item_units_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "item_units_factor_positive" CHECK ("factor" > 0)
);
CREATE UNIQUE INDEX "item_units_itemId_uomId_key" ON "ld_erp"."item_units"("itemId", "uomId");
ALTER TABLE "ld_erp"."item_units" ADD CONSTRAINT "item_units_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "ld_erp"."items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ld_erp"."item_units" ADD CONSTRAINT "item_units_uomId_fkey" FOREIGN KEY ("uomId") REFERENCES "ld_erp"."uom"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ld_erp"."purchase_enquiry_lines" ADD COLUMN "uomId" TEXT, ADD COLUMN "uomFactor" DECIMAL(12,4) NOT NULL DEFAULT 1;
ALTER TABLE "ld_erp"."purchase_order_lines" ADD COLUMN "uomId" TEXT, ADD COLUMN "uomFactor" DECIMAL(12,4) NOT NULL DEFAULT 1;
ALTER TABLE "ld_erp"."grn_lines" ADD COLUMN "uomId" TEXT, ADD COLUMN "uomFactor" DECIMAL(12,4) NOT NULL DEFAULT 1;
ALTER TABLE "ld_erp"."purchase_invoice_lines" ADD COLUMN "uomId" TEXT, ADD COLUMN "uomFactor" DECIMAL(12,4) NOT NULL DEFAULT 1;
ALTER TABLE "ld_erp"."purchase_return_lines" ADD COLUMN "uomId" TEXT, ADD COLUMN "uomFactor" DECIMAL(12,4) NOT NULL DEFAULT 1;
ALTER TABLE "ld_erp"."purchase_note_lines" ADD COLUMN "uomId" TEXT, ADD COLUMN "uomFactor" DECIMAL(12,4) NOT NULL DEFAULT 1;

ALTER TABLE "ld_erp"."purchase_enquiry_lines" ADD CONSTRAINT "purchase_enquiry_lines_uomId_fkey" FOREIGN KEY ("uomId") REFERENCES "ld_erp"."uom"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ld_erp"."purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_uomId_fkey" FOREIGN KEY ("uomId") REFERENCES "ld_erp"."uom"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ld_erp"."grn_lines" ADD CONSTRAINT "grn_lines_uomId_fkey" FOREIGN KEY ("uomId") REFERENCES "ld_erp"."uom"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ld_erp"."purchase_invoice_lines" ADD CONSTRAINT "purchase_invoice_lines_uomId_fkey" FOREIGN KEY ("uomId") REFERENCES "ld_erp"."uom"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ld_erp"."purchase_return_lines" ADD CONSTRAINT "purchase_return_lines_uomId_fkey" FOREIGN KEY ("uomId") REFERENCES "ld_erp"."uom"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ld_erp"."purchase_note_lines" ADD CONSTRAINT "purchase_note_lines_uomId_fkey" FOREIGN KEY ("uomId") REFERENCES "ld_erp"."uom"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
