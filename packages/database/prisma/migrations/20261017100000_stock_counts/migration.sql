-- Stock count by scanning stickers.
--
-- A store keeper walks one store's racks and scans every package sticker.
-- What was scanned is set against what the store should hold; the differences
-- become an ordinary stock adjustment for a store manager to approve, and the
-- stickers nobody found are withdrawn when it is.
--
-- Two new tables and the SC numbering series (SC-2627-0001). Nothing existing
-- is changed. Written by hand and applied with `prisma migrate deploy`.

-- CreateTable
CREATE TABLE "stock_counts" (
    "id" TEXT NOT NULL,
    "countNumber" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "notes" TEXT,
    "loose" JSONB,
    "missing" JSONB,
    "startedById" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submittedAt" TIMESTAMP(3),
    "adjustmentId" TEXT,
    "closedAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stock_counts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_count_scans" (
    "id" TEXT NOT NULL,
    "countId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "packageId" TEXT,
    "result" TEXT NOT NULL,
    "qty" DECIMAL(10,3),
    "scannedById" TEXT,
    "scannedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_count_scans_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "stock_counts_countNumber_key" ON "stock_counts"("countNumber");

-- CreateIndex
CREATE UNIQUE INDEX "stock_counts_adjustmentId_key" ON "stock_counts"("adjustmentId");

-- CreateIndex
CREATE INDEX "stock_counts_warehouseId_status_idx" ON "stock_counts"("warehouseId", "status");

-- CreateIndex
CREATE INDEX "stock_count_scans_countId_idx" ON "stock_count_scans"("countId");

-- CreateIndex
CREATE UNIQUE INDEX "stock_count_scans_countId_code_key" ON "stock_count_scans"("countId", "code");

-- AddForeignKey
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_startedById_fkey" FOREIGN KEY ("startedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_adjustmentId_fkey" FOREIGN KEY ("adjustmentId") REFERENCES "stock_adjustments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_count_scans" ADD CONSTRAINT "stock_count_scans_countId_fkey" FOREIGN KEY ("countId") REFERENCES "stock_counts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_count_scans" ADD CONSTRAINT "stock_count_scans_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "stock_packages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_count_scans" ADD CONSTRAINT "stock_count_scans_scannedById_fkey" FOREIGN KEY ("scannedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Numbering for counts: SC-2627-0001. Written for every company that has none yet.
INSERT INTO "number_series" (
  "id", "companyId", "docType", "prefix", "separator",
  "financialYear", "lastNumber", "padding", "isActive"
)
SELECT
  gen_random_uuid()::text,
  c."id",
  'SC',
  'SC',
  '-',
  COALESCE(NULLIF(c."currentFY", ''), '2627'),
  0,
  4,
  true
FROM "company" c
WHERE NOT EXISTS (
  SELECT 1 FROM "number_series" ns
  WHERE ns."companyId" = c."id" AND ns."docType" = 'SC'
);
