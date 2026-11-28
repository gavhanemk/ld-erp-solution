-- A customer's rolls, roll by roll, on their receipt (28 Nov 2026).
-- A new table only; nothing existing changes.
-- (Its first draft also made delivery_challan_rolls, for rolls typed at
-- dispatch. That idea was dropped before release — the rolls are read from
-- production — so the live database never gets that table: the owner's
-- decision of 28 Nov 2026. Local test copies that ran the first draft had it
-- removed there.)

-- CreateTable
CREATE TABLE "customer_grn_rolls" (
    "id" TEXT NOT NULL,
    "lineId" TEXT NOT NULL,
    "barcode" TEXT NOT NULL,
    "meters" DECIMAL(10,3) NOT NULL,
    "designNo" TEXT,
    "lotNo" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "customer_grn_rolls_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customer_grn_rolls_lineId_idx" ON "customer_grn_rolls"("lineId");

-- CreateIndex
CREATE INDEX "customer_grn_rolls_barcode_idx" ON "customer_grn_rolls"("barcode");

-- AddForeignKey
ALTER TABLE "customer_grn_rolls" ADD CONSTRAINT "customer_grn_rolls_lineId_fkey" FOREIGN KEY ("lineId") REFERENCES "customer_grn_lines"("id") ON DELETE CASCADE ON UPDATE CASCADE;
