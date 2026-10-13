-- Labelled packages of stock (rolls, boxes, cartons) with QR stickers, and
-- the per-category switch that turns them on. Additive only.

-- CreateEnum
CREATE TYPE "PackType" AS ENUM ('BOX', 'ROLL', 'CARTON', 'BAG', 'BUNDLE', 'PACKET', 'OTHER');

-- CreateEnum
CREATE TYPE "PackageStatus" AS ENUM ('IN_STOCK', 'EMPTY', 'SPLIT', 'VOID');

-- CreateEnum
CREATE TYPE "PackageMoveType" AS ENUM ('CREATED', 'ISSUED', 'TRANSFERRED', 'SPLIT', 'SPLIT_FROM', 'CORRECTED', 'VOIDED');

-- AlterTable
ALTER TABLE "item_categories" ADD COLUMN     "packType" "PackType",
ADD COLUMN     "trackPackages" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "stock_packages" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "ownership" "StockOwnership" NOT NULL DEFAULT 'OWNED',
    "ownerCustomerId" TEXT,
    "packType" "PackType" NOT NULL DEFAULT 'BOX',
    "initialQty" DECIMAL(10,3) NOT NULL,
    "qty" DECIMAL(10,3) NOT NULL,
    "lotNo" TEXT,
    "notes" TEXT,
    "status" "PackageStatus" NOT NULL DEFAULT 'IN_STOCK',
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT,
    "grnLineId" TEXT,
    "parentId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stock_packages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_package_moves" (
    "id" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "type" "PackageMoveType" NOT NULL,
    "qty" DECIMAL(10,3) NOT NULL,
    "balanceAfter" DECIMAL(10,3) NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "toWarehouseId" TEXT,
    "referenceType" TEXT,
    "referenceId" TEXT,
    "referenceNumber" TEXT,
    "relatedPackageId" TEXT,
    "notes" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_package_moves_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "stock_packages_code_key" ON "stock_packages"("code");

-- CreateIndex
CREATE INDEX "stock_packages_itemId_warehouseId_status_idx" ON "stock_packages"("itemId", "warehouseId", "status");

-- CreateIndex
CREATE INDEX "stock_packages_sourceType_sourceId_idx" ON "stock_packages"("sourceType", "sourceId");

-- CreateIndex
CREATE INDEX "stock_packages_parentId_idx" ON "stock_packages"("parentId");

-- CreateIndex
CREATE INDEX "stock_package_moves_packageId_createdAt_idx" ON "stock_package_moves"("packageId", "createdAt");

-- AddForeignKey
ALTER TABLE "stock_packages" ADD CONSTRAINT "stock_packages_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_packages" ADD CONSTRAINT "stock_packages_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_packages" ADD CONSTRAINT "stock_packages_ownerCustomerId_fkey" FOREIGN KEY ("ownerCustomerId") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_packages" ADD CONSTRAINT "stock_packages_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "stock_packages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_package_moves" ADD CONSTRAINT "stock_package_moves_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "stock_packages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_package_moves" ADD CONSTRAINT "stock_package_moves_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- The running number behind each sticker's code: PK-000001, PK-000002, ...
-- A sequence, so two people labelling at once can never be given the same code.
CREATE SEQUENCE IF NOT EXISTS "stock_package_code_seq";
