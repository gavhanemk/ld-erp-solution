-- FIFO on packages: a newer package goes out before an older one of the same
-- item, store and owner only when the store manager allows it, with a reason.
-- The older package skipped and the reason are kept on the newer one's move.
-- Additive only.
ALTER TABLE "stock_package_moves" ADD COLUMN     "fifoSkippedId" TEXT,
ADD COLUMN     "fifoReason" TEXT;
