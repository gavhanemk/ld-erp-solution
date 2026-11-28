-- A quotation line's pieces size by size (28 Nov 2026), as on a sales order.
-- A new table only: quotations already saved keep their total and no sizes.
CREATE TABLE "sales_quotation_line_sizes" (
    "id" TEXT NOT NULL,
    "lineId" TEXT NOT NULL,
    "sizeId" TEXT NOT NULL,
    "qty" DECIMAL(10,2) NOT NULL,

    CONSTRAINT "sales_quotation_line_sizes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "sales_quotation_line_sizes_lineId_sizeId_key" ON "sales_quotation_line_sizes"("lineId", "sizeId");

ALTER TABLE "sales_quotation_line_sizes" ADD CONSTRAINT "sales_quotation_line_sizes_lineId_fkey" FOREIGN KEY ("lineId") REFERENCES "sales_quotation_lines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "sales_quotation_line_sizes" ADD CONSTRAINT "sales_quotation_line_sizes_sizeId_fkey" FOREIGN KEY ("sizeId") REFERENCES "sizes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
