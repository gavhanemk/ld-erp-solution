-- More than one billing address per supplier, and the order remembers which
-- one it was raised against.
--
-- Additive. One new table, one new nullable column, two indexes and one
-- foreign key. Nothing renamed, nothing dropped, no existing row rewritten.
--
-- The addresses suppliers already have are copied in as their default by a
-- separate script, not here: ids in this database are cuids, which Postgres
-- cannot generate, and inventing a different id shape for these rows alone
-- would be a wart for as long as the table exists.

-- CreateTable
CREATE TABLE "supplier_addresses" (
    "id" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "label" TEXT,
    "address" TEXT NOT NULL,
    "city" TEXT,
    "state" TEXT,
    "stateCode" TEXT,
    "pincode" TEXT,
    "country" TEXT DEFAULT 'India',
    "gstin" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "supplier_addresses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "supplier_addresses_supplierId_idx" ON "supplier_addresses"("supplierId");

-- AddForeignKey
ALTER TABLE "supplier_addresses" ADD CONSTRAINT "supplier_addresses_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "purchase_orders" ADD COLUMN     "supplierAddress" TEXT;
