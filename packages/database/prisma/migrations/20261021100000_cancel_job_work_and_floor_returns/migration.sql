-- Job-work receipts and floor returns can be cancelled when entered by mistake.
-- A floor return becomes a document of its own (FR-…), so one return can be
-- told from another and taken back on its own.

-- AlterTable
ALTER TABLE "job_work_returns" ADD COLUMN     "cancelReason" TEXT,
ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "cancelledById" TEXT;

-- CreateTable
CREATE TABLE "floor_returns" (
    "id" TEXT NOT NULL,
    "returnNumber" TEXT NOT NULL,
    "mrId" TEXT NOT NULL,
    "returnDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelledAt" TIMESTAMP(3),
    "cancelledById" TEXT,
    "cancelReason" TEXT,

    CONSTRAINT "floor_returns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "floor_return_lines" (
    "id" TEXT NOT NULL,
    "returnId" TEXT NOT NULL,
    "mrLineId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "qty" DECIMAL(10,3) NOT NULL,

    CONSTRAINT "floor_return_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "floor_returns_returnNumber_key" ON "floor_returns"("returnNumber");

-- CreateIndex
CREATE INDEX "floor_returns_mrId_idx" ON "floor_returns"("mrId");

-- CreateIndex
CREATE INDEX "floor_return_lines_returnId_idx" ON "floor_return_lines"("returnId");

-- CreateIndex
CREATE INDEX "floor_return_lines_mrLineId_idx" ON "floor_return_lines"("mrLineId");

-- AddForeignKey
ALTER TABLE "floor_returns" ADD CONSTRAINT "floor_returns_mrId_fkey" FOREIGN KEY ("mrId") REFERENCES "material_requisitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "floor_returns" ADD CONSTRAINT "floor_returns_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "floor_returns" ADD CONSTRAINT "floor_returns_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "floor_return_lines" ADD CONSTRAINT "floor_return_lines_returnId_fkey" FOREIGN KEY ("returnId") REFERENCES "floor_returns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "floor_return_lines" ADD CONSTRAINT "floor_return_lines_mrLineId_fkey" FOREIGN KEY ("mrLineId") REFERENCES "material_requisition_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_work_returns" ADD CONSTRAINT "job_work_returns_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Numbering for floor returns: FR-2627-0001.
INSERT INTO "number_series" (
  "id", "companyId", "docType", "prefix", "separator",
  "financialYear", "lastNumber", "padding", "isActive"
)
SELECT
  gen_random_uuid()::text,
  c."id",
  'FR',
  'FR',
  '-',
  COALESCE(NULLIF(c."currentFY", ''), '2627'),
  0,
  4,
  true
FROM "company" c
WHERE NOT EXISTS (
  SELECT 1 FROM "number_series" ns
  WHERE ns."companyId" = c."id" AND ns."docType" = 'FR'
);
