-- Sampling phase 5: making the sample colour by colour and size by size, with
-- hand-ons between steps, outside units on a job-work challan, and labour.
-- Only sample_* tables change, and four new ones hold the making records.
-- Sample pieces are not stock: nothing here moves stock.

-- AlterTable: a step's labour, and steps recorded in one go before this.
ALTER TABLE "sample_stages" ADD COLUMN "wholeStep" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "labourAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN "labourNote" TEXT;

-- Every step already recorded was recorded whole: its done and rejected
-- figures are the step's, not a colour's or a size's.
UPDATE "sample_stages" SET "wholeStep" = true WHERE "completedAt" IS NOT NULL;

ALTER TABLE sample_stages ADD CONSTRAINT sample_stage_labour CHECK ("labourAmount" >= 0);

-- CreateTable: work recorded at a step on our own floor.
CREATE TABLE "sample_works" (
    "id" TEXT NOT NULL,
    "roundId" TEXT NOT NULL,
    "stageId" TEXT NOT NULL,
    "cells" JSONB NOT NULL,
    "doneBy" TEXT NOT NULL,
    "workedOn" TIMESTAMP(3) NOT NULL,
    "notes" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "undoneAt" TIMESTAMP(3),
    "undoneBy" TEXT,
    "undoneReason" TEXT,

    CONSTRAINT "sample_works_pkey" PRIMARY KEY ("id")
);

-- CreateTable: pieces handed on from one step to the next.
CREATE TABLE "sample_transfers" (
    "id" TEXT NOT NULL,
    "roundId" TEXT NOT NULL,
    "fromStageId" TEXT NOT NULL,
    "toStageId" TEXT NOT NULL,
    "cells" JSONB NOT NULL,
    "sentBy" TEXT NOT NULL,
    "sentOn" TIMESTAMP(3) NOT NULL,
    "receivedCells" JSONB,
    "receivedBy" TEXT,
    "receivedOn" TIMESTAMP(3),
    "shortReason" TEXT,
    "notes" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "undoneAt" TIMESTAMP(3),
    "undoneBy" TEXT,
    "undoneReason" TEXT,

    CONSTRAINT "sample_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable: pieces given to an outside unit on a job-work challan.
CREATE TABLE "sample_job_works" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "roundId" TEXT NOT NULL,
    "stageId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "cells" JSONB NOT NULL,
    "sentBy" TEXT NOT NULL,
    "sentOn" TIMESTAMP(3) NOT NULL,
    "expectedBack" TIMESTAMP(3),
    "vehicleNo" TEXT,
    "declaredValue" DECIMAL(12,2),
    "notes" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelledAt" TIMESTAMP(3),
    "cancelledBy" TEXT,
    "cancelReason" TEXT,

    CONSTRAINT "sample_job_works_pkey" PRIMARY KEY ("id")
);

-- CreateTable: what came back from the unit on a challan.
CREATE TABLE "sample_job_returns" (
    "id" TEXT NOT NULL,
    "jobWorkId" TEXT NOT NULL,
    "cells" JSONB NOT NULL,
    "theirChallanNo" TEXT,
    "receivedBy" TEXT NOT NULL,
    "receivedOn" TIMESTAMP(3) NOT NULL,
    "chargeAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "undoneAt" TIMESTAMP(3),
    "undoneBy" TEXT,
    "undoneReason" TEXT,

    CONSTRAINT "sample_job_returns_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sample_works_roundId_idx" ON "sample_works"("roundId");

-- CreateIndex
CREATE INDEX "sample_transfers_roundId_idx" ON "sample_transfers"("roundId");

-- CreateIndex
CREATE UNIQUE INDEX "sample_job_works_number_key" ON "sample_job_works"("number");

-- CreateIndex
CREATE INDEX "sample_job_works_roundId_idx" ON "sample_job_works"("roundId");

-- CreateIndex
CREATE INDEX "sample_job_returns_jobWorkId_idx" ON "sample_job_returns"("jobWorkId");

-- AddForeignKey
ALTER TABLE "sample_works" ADD CONSTRAINT "sample_works_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "sample_rounds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sample_works" ADD CONSTRAINT "sample_works_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "sample_stages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sample_transfers" ADD CONSTRAINT "sample_transfers_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "sample_rounds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sample_transfers" ADD CONSTRAINT "sample_transfers_fromStageId_fkey" FOREIGN KEY ("fromStageId") REFERENCES "sample_stages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sample_transfers" ADD CONSTRAINT "sample_transfers_toStageId_fkey" FOREIGN KEY ("toStageId") REFERENCES "sample_stages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sample_job_works" ADD CONSTRAINT "sample_job_works_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "sample_rounds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sample_job_works" ADD CONSTRAINT "sample_job_works_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "sample_stages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sample_job_works" ADD CONSTRAINT "sample_job_works_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sample_job_returns" ADD CONSTRAINT "sample_job_returns_jobWorkId_fkey" FOREIGN KEY ("jobWorkId") REFERENCES "sample_job_works"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The records' own shape. The piece arithmetic across them (no more worked
-- than arrived, no more handed on than done) is the service's, over all of a
-- round's records at once.
ALTER TABLE sample_works ADD CONSTRAINT sample_work_shape CHECK (
  jsonb_typeof("cells") = 'array' AND ("undoneAt" IS NULL) = ("undoneReason" IS NULL)
);
ALTER TABLE sample_transfers ADD CONSTRAINT sample_transfer_shape CHECK (
  jsonb_typeof("cells") = 'array'
  AND "fromStageId" <> "toStageId"
  AND ("receivedOn" IS NULL) = ("receivedCells" IS NULL)
  AND ("receivedOn" IS NULL) = ("receivedBy" IS NULL)
  AND ("receivedCells" IS NULL OR jsonb_typeof("receivedCells") = 'array')
  AND ("undoneAt" IS NULL) = ("undoneReason" IS NULL)
);
ALTER TABLE sample_job_works ADD CONSTRAINT sample_job_work_shape CHECK (
  jsonb_typeof("cells") = 'array'
  AND ("declaredValue" IS NULL OR "declaredValue" >= 0)
  AND ("cancelledAt" IS NULL) = ("cancelReason" IS NULL)
);
ALTER TABLE sample_job_returns ADD CONSTRAINT sample_job_return_shape CHECK (
  jsonb_typeof("cells") = 'array'
  AND "chargeAmount" >= 0
  AND ("undoneAt" IS NULL) = ("undoneReason" IS NULL)
);
