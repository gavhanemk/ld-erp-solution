-- Two-step transfers: sent now, confirmed by the other store when they arrive.
-- Every transfer until now went straight there, so each is DIRECT and RECEIVED
-- (or CANCELLED, when it was taken back).

CREATE TYPE "TransferMode" AS ENUM ('DIRECT', 'IN_TRANSIT');
CREATE TYPE "TransferReceiptKind" AS ENUM ('RECEIVED', 'RETURNED', 'WRITTEN_OFF');

ALTER TABLE "stock_transfers"
  ADD COLUMN "mode" "TransferMode" NOT NULL DEFAULT 'DIRECT',
  ADD COLUMN "status" "TransferStatus" NOT NULL DEFAULT 'RECEIVED',
  ADD COLUMN "transitWarehouseId" TEXT;

UPDATE "stock_transfers" SET "status" = 'CANCELLED' WHERE "cancelledAt" IS NOT NULL;

ALTER TABLE "stock_transfers"
  ADD CONSTRAINT "stock_transfers_transitWarehouseId_fkey" FOREIGN KEY ("transitWarehouseId") REFERENCES "warehouses"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "stock_transfers_status_idx" ON "stock_transfers"("status");

ALTER TABLE "stock_transfer_lines"
  ADD COLUMN "receivedQty" DECIMAL(10,3) NOT NULL DEFAULT 0,
  ADD COLUMN "damagedQty" DECIMAL(10,3) NOT NULL DEFAULT 0,
  ADD COLUMN "returnedQty" DECIMAL(10,3) NOT NULL DEFAULT 0,
  ADD COLUMN "lostQty" DECIMAL(10,3) NOT NULL DEFAULT 0;
-- Only an in-transit transfer fills these in; a direct one arrived whole when it was saved.

CREATE TABLE "stock_transfer_receipts" (
  "id" TEXT NOT NULL,
  "transferId" TEXT NOT NULL,
  "kind" "TransferReceiptKind" NOT NULL,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "byId" TEXT,
  "notes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "stock_transfer_receipts_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "stock_transfer_receipts_transferId_idx" ON "stock_transfer_receipts"("transferId");
ALTER TABLE "stock_transfer_receipts"
  ADD CONSTRAINT "stock_transfer_receipts_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "stock_transfers"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "stock_transfer_receipts_byId_fkey" FOREIGN KEY ("byId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "stock_transfer_receipt_lines" (
  "id" TEXT NOT NULL,
  "receiptId" TEXT NOT NULL,
  "transferLineId" TEXT NOT NULL,
  "qty" DECIMAL(10,3) NOT NULL DEFAULT 0,
  "damagedQty" DECIMAL(10,3) NOT NULL DEFAULT 0,
  CONSTRAINT "stock_transfer_receipt_lines_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "stock_transfer_receipt_lines_transferLineId_idx" ON "stock_transfer_receipt_lines"("transferLineId");
ALTER TABLE "stock_transfer_receipt_lines"
  ADD CONSTRAINT "stock_transfer_receipt_lines_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "stock_transfer_receipts"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "stock_transfer_receipt_lines_transferLineId_fkey" FOREIGN KEY ("transferLineId") REFERENCES "stock_transfer_lines"("id") ON DELETE CASCADE ON UPDATE CASCADE;
