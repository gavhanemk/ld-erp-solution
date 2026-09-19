-- Delivering a purchase straight to a customer, and the address as it read
-- on the day. Both optional: every order already on the system goes to one
-- of our own warehouses.

-- AlterTable
ALTER TABLE "purchase_orders" ADD COLUMN     "deliveryAddress" TEXT,
ADD COLUMN     "deliveryCustomerId" TEXT;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_deliveryCustomerId_fkey" FOREIGN KEY ("deliveryCustomerId") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

