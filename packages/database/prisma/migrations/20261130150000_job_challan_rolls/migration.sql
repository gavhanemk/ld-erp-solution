-- A customer's rolls, roll by roll, on their receipt, and on the job-work
-- delivery challan the pieces made from them go out on (28 Nov 2026).
-- New tables only; nothing existing changes.

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

-- CreateTable
CREATE TABLE "delivery_challan_rolls" (
    "id" TEXT NOT NULL,
    "dcId" TEXT NOT NULL,
    "rollId" TEXT NOT NULL,
    "soLineId" TEXT,
    "baleNo" TEXT,
    "pieces" DECIMAL(10,2) NOT NULL,
    "grade" TEXT NOT NULL DEFAULT 'A',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "delivery_challan_rolls_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customer_grn_rolls_lineId_idx" ON "customer_grn_rolls"("lineId");

-- CreateIndex
CREATE INDEX "customer_grn_rolls_barcode_idx" ON "customer_grn_rolls"("barcode");

-- CreateIndex
CREATE INDEX "delivery_challan_rolls_dcId_idx" ON "delivery_challan_rolls"("dcId");

-- CreateIndex
CREATE INDEX "delivery_challan_rolls_rollId_idx" ON "delivery_challan_rolls"("rollId");

-- AddForeignKey
ALTER TABLE "customer_grn_rolls" ADD CONSTRAINT "customer_grn_rolls_lineId_fkey" FOREIGN KEY ("lineId") REFERENCES "customer_grn_lines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_challan_rolls" ADD CONSTRAINT "delivery_challan_rolls_dcId_fkey" FOREIGN KEY ("dcId") REFERENCES "delivery_challans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_challan_rolls" ADD CONSTRAINT "delivery_challan_rolls_rollId_fkey" FOREIGN KEY ("rollId") REFERENCES "customer_grn_rolls"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_challan_rolls" ADD CONSTRAINT "delivery_challan_rolls_soLineId_fkey" FOREIGN KEY ("soLineId") REFERENCES "sales_order_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE;
