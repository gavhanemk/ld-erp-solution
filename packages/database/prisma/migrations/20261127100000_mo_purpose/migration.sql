-- What a manufacturing order is made for: a sales order (ORDER), or a direct
-- order with none, for stock (STOCK), samples (SAMPLE) or a customer whose
-- order is not raised (CUSTOMER) — then who it is for.
CREATE TYPE "MOPurpose" AS ENUM ('ORDER', 'STOCK', 'SAMPLE', 'CUSTOMER');

ALTER TABLE "manufacturing_orders" ADD COLUMN "purpose" "MOPurpose" NOT NULL DEFAULT 'ORDER';
ALTER TABLE "manufacturing_orders" ADD COLUMN "customerId" TEXT;
ALTER TABLE "manufacturing_orders" ADD CONSTRAINT "manufacturing_orders_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Any order already without a sales order was made for stock.
UPDATE "manufacturing_orders" SET "purpose" = 'STOCK' WHERE "soId" IS NULL;
