-- What a manufacturing order is made for: a sales order (ORDER), or a direct
-- order with none, for stock (STOCK) or samples (SAMPLE).
CREATE TYPE "MOPurpose" AS ENUM ('ORDER', 'STOCK', 'SAMPLE');

ALTER TABLE "manufacturing_orders" ADD COLUMN "purpose" "MOPurpose" NOT NULL DEFAULT 'ORDER';

-- Any order already without a sales order was made for stock.
UPDATE "manufacturing_orders" SET "purpose" = 'STOCK' WHERE "soId" IS NULL;
