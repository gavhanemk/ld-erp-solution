-- Opening stock from the mill's 19-column sheet, and work in progress kept
-- size by size on each process's own floor. Only adds: no existing row changes.

-- AlterTable
ALTER TABLE "warehouses" ADD COLUMN     "departmentId" TEXT;

-- AlterTable
ALTER TABLE "stock_ledger" ADD COLUMN     "orderNo" TEXT;

-- AlterTable
ALTER TABLE "stock_transfer_lines" ADD COLUMN     "bundleNo" TEXT,
ADD COLUMN     "lotNo" TEXT,
ADD COLUMN     "orderNo" TEXT;

-- CreateTable
CREATE TABLE "opening_stocks" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "fileName" TEXT,
    "notes" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "opening_stocks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "opening_stock_lines" (
    "id" TEXT NOT NULL,
    "openingStockId" TEXT NOT NULL,
    "rowNo" INTEGER NOT NULL,
    "openingDate" DATE NOT NULL,
    "processText" TEXT,
    "departmentId" TEXT,
    "locationText" TEXT,
    "warehouseId" TEXT NOT NULL,
    "orderNo" TEXT,
    "styleText" TEXT,
    "itemId" TEXT NOT NULL,
    "itemCodeText" TEXT,
    "description" TEXT,
    "categoryText" TEXT,
    "fabricText" TEXT,
    "colour" TEXT,
    "sizeId" TEXT,
    "sizeText" TEXT,
    "lotNo" TEXT,
    "bundleNo" TEXT,
    "uomText" TEXT,
    "qty" DECIMAL(12,3) NOT NULL,
    "unitRate" DECIMAL(12,2) NOT NULL,
    "value" DECIMAL(14,2) NOT NULL,
    "status" TEXT NOT NULL,
    "grade" TEXT NOT NULL,
    "remarks" TEXT,
    "packageId" TEXT,
    "dedupeKey" TEXT NOT NULL,

    CONSTRAINT "opening_stock_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "opening_stocks_number_key" ON "opening_stocks"("number");

-- CreateIndex
CREATE UNIQUE INDEX "opening_stock_lines_dedupeKey_key" ON "opening_stock_lines"("dedupeKey");

-- CreateIndex
CREATE INDEX "opening_stock_lines_openingStockId_idx" ON "opening_stock_lines"("openingStockId");

-- CreateIndex
CREATE INDEX "opening_stock_lines_itemId_warehouseId_idx" ON "opening_stock_lines"("itemId", "warehouseId");

-- CreateIndex
CREATE INDEX "opening_stock_lines_orderNo_idx" ON "opening_stock_lines"("orderNo");

-- CreateIndex
CREATE UNIQUE INDEX "warehouses_departmentId_key" ON "warehouses"("departmentId");

-- CreateIndex
CREATE INDEX "stock_ledger_orderNo_idx" ON "stock_ledger"("orderNo");

-- AddForeignKey
ALTER TABLE "warehouses" ADD CONSTRAINT "warehouses_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opening_stocks" ADD CONSTRAINT "opening_stocks_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opening_stock_lines" ADD CONSTRAINT "opening_stock_lines_openingStockId_fkey" FOREIGN KEY ("openingStockId") REFERENCES "opening_stocks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opening_stock_lines" ADD CONSTRAINT "opening_stock_lines_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opening_stock_lines" ADD CONSTRAINT "opening_stock_lines_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opening_stock_lines" ADD CONSTRAINT "opening_stock_lines_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opening_stock_lines" ADD CONSTRAINT "opening_stock_lines_sizeId_fkey" FOREIGN KEY ("sizeId") REFERENCES "sizes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Numbering for opening-stock imports: OPS-2627-0001. Written for every company
-- that has none yet.
INSERT INTO "number_series" (
  "id", "companyId", "docType", "prefix", "separator",
  "financialYear", "lastNumber", "padding", "isActive"
)
SELECT
  gen_random_uuid()::text,
  c."id",
  'OPS',
  'OPS',
  '-',
  COALESCE(NULLIF(c."currentFY", ''), '2627'),
  0,
  4,
  true
FROM "company" c
WHERE NOT EXISTS (
  SELECT 1 FROM "number_series" ns
  WHERE ns."companyId" = c."id" AND ns."docType" = 'OPS'
);
