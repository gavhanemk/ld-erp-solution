-- CreateEnum
CREATE TYPE "FgCartonStatus" AS ENUM ('PACKED', 'DISPATCHED', 'OPENED');

-- CreateTable
CREATE TABLE "fg_cartons" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "status" "FgCartonStatus" NOT NULL DEFAULT 'PACKED',
    "soId" TEXT,
    "dcId" TEXT,
    "notes" TEXT,
    "printCount" INTEGER NOT NULL DEFAULT 0,
    "lastPrintedAt" TIMESTAMP(3),
    "dispatchedAt" TIMESTAMP(3),
    "openedAt" TIMESTAMP(3),
    "openReason" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fg_cartons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fg_carton_lines" (
    "id" TEXT NOT NULL,
    "cartonId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "sizeId" TEXT NOT NULL,
    "grade" TEXT NOT NULL DEFAULT 'A',
    "qty" INTEGER NOT NULL,

    CONSTRAINT "fg_carton_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "fg_cartons_code_key" ON "fg_cartons"("code");

-- CreateIndex
CREATE INDEX "fg_cartons_warehouseId_status_idx" ON "fg_cartons"("warehouseId", "status");

-- CreateIndex
CREATE INDEX "fg_cartons_dcId_idx" ON "fg_cartons"("dcId");

-- CreateIndex
CREATE INDEX "fg_cartons_soId_idx" ON "fg_cartons"("soId");

-- CreateIndex
CREATE INDEX "fg_carton_lines_cartonId_idx" ON "fg_carton_lines"("cartonId");

-- CreateIndex
CREATE INDEX "fg_carton_lines_itemId_sizeId_idx" ON "fg_carton_lines"("itemId", "sizeId");

-- AddForeignKey
ALTER TABLE "fg_cartons" ADD CONSTRAINT "fg_cartons_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fg_cartons" ADD CONSTRAINT "fg_cartons_soId_fkey" FOREIGN KEY ("soId") REFERENCES "sales_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fg_cartons" ADD CONSTRAINT "fg_cartons_dcId_fkey" FOREIGN KEY ("dcId") REFERENCES "delivery_challans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fg_cartons" ADD CONSTRAINT "fg_cartons_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fg_carton_lines" ADD CONSTRAINT "fg_carton_lines_cartonId_fkey" FOREIGN KEY ("cartonId") REFERENCES "fg_cartons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fg_carton_lines" ADD CONSTRAINT "fg_carton_lines_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fg_carton_lines" ADD CONSTRAINT "fg_carton_lines_sizeId_fkey" FOREIGN KEY ("sizeId") REFERENCES "sizes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- The running number behind each carton sticker: CT-0001, CT-0002, ...
-- A sequence, so two people packing at once are never given the same number.
CREATE SEQUENCE IF NOT EXISTS "fg_carton_code_seq";
