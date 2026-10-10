-- AlterTable
ALTER TABLE "sales_orders" ADD COLUMN     "billingAddress" TEXT,
ADD COLUMN     "otherCharges" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "reference" TEXT,
ADD COLUMN     "terms" TEXT;

-- AlterTable
ALTER TABLE "sales_order_lines" ADD COLUMN     "description" TEXT,
ADD COLUMN     "fabric" TEXT,
ADD COLUMN     "gender" TEXT,
ADD COLUMN     "printName" TEXT,
ADD COLUMN     "taxExempt" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "sales_order_charges" (
    "id" TEXT NOT NULL,
    "soId" TEXT NOT NULL,
    "chargeTypeId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "gstRate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "cgst" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "sgst" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "igst" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "sales_order_charges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_order_attachments" (
    "id" TEXT NOT NULL,
    "soId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "mimeType" TEXT,
    "sizeBytes" INTEGER NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_order_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sales_order_charges_soId_idx" ON "sales_order_charges"("soId");

-- CreateIndex
CREATE UNIQUE INDEX "sales_order_charges_soId_chargeTypeId_key" ON "sales_order_charges"("soId", "chargeTypeId");

-- CreateIndex
CREATE UNIQUE INDEX "sales_order_attachments_storagePath_key" ON "sales_order_attachments"("storagePath");

-- CreateIndex
CREATE INDEX "sales_order_attachments_soId_idx" ON "sales_order_attachments"("soId");

-- AddForeignKey
ALTER TABLE "sales_order_charges" ADD CONSTRAINT "sales_order_charges_soId_fkey" FOREIGN KEY ("soId") REFERENCES "sales_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order_charges" ADD CONSTRAINT "sales_order_charges_chargeTypeId_fkey" FOREIGN KEY ("chargeTypeId") REFERENCES "charge_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order_attachments" ADD CONSTRAINT "sales_order_attachments_soId_fkey" FOREIGN KEY ("soId") REFERENCES "sales_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order_attachments" ADD CONSTRAINT "sales_order_attachments_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

