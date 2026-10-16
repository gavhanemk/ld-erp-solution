-- Customer GRN controls: draft / submitted / posted receipts, rejected
-- material held apart, held stickers, reprint log, and a request log so a
-- retried issue cannot move stock twice. Additive only: no row is deleted and
-- no stock figure changes.

ALTER TYPE "PackageMoveType" ADD VALUE 'PRINTED';
ALTER TYPE "PackageMoveType" ADD VALUE 'RELEASED';

-- AlterTable
ALTER TABLE "customer_grn" ADD COLUMN     "correctionOfId" TEXT,
ADD COLUMN     "inspectionNotes" TEXT,
ADD COLUMN     "postedAt" TIMESTAMP(3),
ADD COLUMN     "postedById" TEXT,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'POSTED',
ADD COLUMN     "submittedAt" TIMESTAMP(3),
ADD COLUMN     "submittedById" TEXT;

-- AlterTable
ALTER TABLE "customer_grn_lines" ADD COLUMN     "rejectReason" TEXT,
ADD COLUMN     "releasedQty" DECIMAL(10,3) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "stock_packages" ADD COLUMN     "grade" TEXT NOT NULL DEFAULT 'A';

-- CreateTable
CREATE TABLE "stock_requests" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "userId" TEXT,
    "result" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "stock_requests_createdAt_idx" ON "stock_requests"("createdAt");

-- CreateIndex
CREATE INDEX "customer_grn_status_idx" ON "customer_grn"("status");

-- AddForeignKey
ALTER TABLE "customer_grn" ADD CONSTRAINT "customer_grn_submittedById_fkey" FOREIGN KEY ("submittedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_grn" ADD CONSTRAINT "customer_grn_postedById_fkey" FOREIGN KEY ("postedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_grn" ADD CONSTRAINT "customer_grn_correctionOfId_fkey" FOREIGN KEY ("correctionOfId") REFERENCES "customer_grn"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Receipts made before this were all booked on save: they are POSTED (the
-- column default) unless cancelled, posted when they were made, by whoever
-- received them.
UPDATE "customer_grn" SET "status" = 'CANCELLED' WHERE "cancelledAt" IS NOT NULL;
UPDATE "customer_grn" SET "postedAt" = "createdAt", "postedById" = "receivedById" WHERE "postedAt" IS NULL;
