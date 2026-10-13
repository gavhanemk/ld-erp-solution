-- Stock that comes in without a purchase order, recorded as a kind of stock
-- adjustment so it is approved the same way. Existing adjustments are counts.
ALTER TABLE "stock_adjustments" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'COUNT',
ADD COLUMN     "source" TEXT;
