-- Layers on a cutting issue can be a part layer (0.1, 0.25, 2.5), not only a
-- whole number. Widened from INTEGER to two decimal places; every existing
-- whole number carries over unchanged (5 becomes 5.00).
ALTER TABLE "cutting_orders" ALTER COLUMN "noOfLayers" TYPE DECIMAL(10,2);
