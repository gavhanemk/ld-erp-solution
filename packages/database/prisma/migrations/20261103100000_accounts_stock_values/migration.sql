-- A day's closing stock as the accountant puts it, in place of inventory's own
-- value. Adds one table only.

-- CreateTable
CREATE TABLE "acc_stock_values" (
    "id" TEXT NOT NULL,
    "asOn" TIMESTAMP(3) NOT NULL,
    "value" DECIMAL(14,2) NOT NULL,
    "inventoryValue" DECIMAL(14,2),
    "notes" TEXT,
    "setById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "acc_stock_values_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "acc_stock_values_asOn_key" ON "acc_stock_values"("asOn");

-- AddForeignKey
ALTER TABLE "acc_stock_values" ADD CONSTRAINT "acc_stock_values_setById_fkey" FOREIGN KEY ("setById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

