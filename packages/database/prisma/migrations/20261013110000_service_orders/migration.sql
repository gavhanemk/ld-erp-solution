-- Service purchase orders: a flag that keeps them apart from goods orders.
-- Additive only -- one boolean with a default; every existing order is goods.

-- AlterTable
ALTER TABLE "purchase_orders" ADD COLUMN "isService" BOOLEAN NOT NULL DEFAULT false;
