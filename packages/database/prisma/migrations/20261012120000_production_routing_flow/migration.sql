-- CreateEnum
CREATE TYPE "ProcessKind" AS ENUM ('CUTTING', 'STITCHING', 'FINISHING', 'QC', 'PACKING', 'OTHER');

-- CreateEnum
CREATE TYPE "StepExecution" AS ENUM ('IN_HOUSE', 'OUTSOURCED');

-- CreateEnum
CREATE TYPE "StepSkip" AS ENUM ('OPTIONAL', 'WITH_APPROVAL', 'NEVER');

-- CreateEnum
CREATE TYPE "WipBucket" AS ENUM ('TRANSIT', 'WIP', 'DONE', 'REWORK', 'DAMAGED', 'REJECTED', 'SHORT', 'B_GRADE', 'SCRAPPED', 'PACKED', 'PACKED_B');

-- CreateEnum
CREATE TYPE "WipEventType" AS ENUM ('CUT', 'DISPATCH', 'RECEIVE', 'SHORT', 'EXCESS', 'SETTLE', 'PROCESS', 'DECIDE', 'REWORK_DONE', 'VENDOR_RETURN', 'PACK', 'SPLIT', 'REVERSAL');

-- CreateEnum
CREATE TYPE "TransferStatus" AS ENUM ('DISPATCHED', 'PARTLY_RECEIVED', 'RECEIVED', 'DISCREPANCY', 'CANCELLED');

-- CreateEnum
CREATE TYPE "JobWorkOrderStatus" AS ENUM ('OPEN', 'CLOSED', 'CANCELLED');

-- AlterTable
ALTER TABLE "operations" ADD COLUMN     "defaultExecution" "StepExecution" NOT NULL DEFAULT 'IN_HOUSE',
ADD COLUMN     "instructions" TEXT,
ADD COLUMN     "kind" "ProcessKind" NOT NULL DEFAULT 'OTHER';

-- AlterTable
ALTER TABLE "manufacturing_orders" ADD COLUMN     "heldAt" TIMESTAMP(3),
ADD COLUMN     "heldById" TEXT,
ADD COLUMN     "holdReason" TEXT,
ADD COLUMN     "progress" TEXT,
ADD COLUMN     "routingId" TEXT,
ADD COLUMN     "routingVersion" INTEGER;

-- AlterTable
ALTER TABLE "cutting_orders" ADD COLUMN     "bundleSize" INTEGER,
ADD COLUMN     "cutterName" TEXT,
ADD COLUMN     "lotNo" TEXT,
ADD COLUMN     "moLineId" TEXT,
ADD COLUMN     "plannedBreakup" JSONB,
ADD COLUMN     "ratio" TEXT;

-- AlterTable
ALTER TABLE "routings" ADD COLUMN     "category" TEXT,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1,
ALTER COLUMN "styleId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "routing_steps" ADD COLUMN     "execution" "StepExecution" NOT NULL DEFAULT 'IN_HOUSE',
ADD COLUMN     "instructions" TEXT,
ADD COLUMN     "skip" "StepSkip" NOT NULL DEFAULT 'WITH_APPROVAL';

-- CreateTable
CREATE TABLE "mo_steps" (
    "id" TEXT NOT NULL,
    "moId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "operationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "ProcessKind" NOT NULL,
    "departmentId" TEXT NOT NULL,
    "execution" "StepExecution" NOT NULL DEFAULT 'IN_HOUSE',
    "workstationId" TEXT,
    "isQcStep" BOOLEAN NOT NULL DEFAULT false,
    "skip" "StepSkip" NOT NULL DEFAULT 'WITH_APPROVAL',
    "ratePerPiece" DECIMAL(10,2),
    "instructions" TEXT,
    "skippedAt" TIMESTAMP(3),
    "skippedById" TEXT,
    "skipReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mo_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_bundles" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "bundleNo" INTEGER NOT NULL,
    "moId" TEXT NOT NULL,
    "moLineId" TEXT NOT NULL,
    "cuttingOrderId" TEXT NOT NULL,
    "sizeId" TEXT,
    "qty" INTEGER NOT NULL,
    "parentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "production_bundles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wip_events" (
    "id" TEXT NOT NULL,
    "moId" TEXT NOT NULL,
    "stepId" TEXT,
    "type" "WipEventType" NOT NULL,
    "eventDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "personName" TEXT,
    "vendorId" TEXT,
    "transferId" TEXT,
    "jobWorkOrderId" TEXT,
    "cuttingOrderId" TEXT,
    "fgReceiptId" TEXT,
    "reworkStepId" TEXT,
    "reason" TEXT,
    "notes" TEXT,
    "theirChallanNo" TEXT,
    "chargeQty" INTEGER,
    "chargeRate" DECIMAL(10,2),
    "billNo" TEXT,
    "billDate" TIMESTAMP(3),
    "reversedAt" TIMESTAMP(3),
    "reversalOfId" TEXT,
    "clientKey" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wip_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wip_entries" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventType" "WipEventType" NOT NULL,
    "moId" TEXT NOT NULL,
    "stepId" TEXT NOT NULL,
    "bundleId" TEXT NOT NULL,
    "moLineId" TEXT NOT NULL,
    "sizeId" TEXT,
    "vendorId" TEXT,
    "bucket" "WipBucket" NOT NULL,
    "qty" INTEGER NOT NULL,
    "reworkStepId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wip_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "process_transfers" (
    "id" TEXT NOT NULL,
    "transferNumber" TEXT NOT NULL,
    "moId" TEXT NOT NULL,
    "fromStepId" TEXT NOT NULL,
    "toStepId" TEXT NOT NULL,
    "vendorId" TEXT,
    "jobWorkOrderId" TEXT,
    "isRework" BOOLEAN NOT NULL DEFAULT false,
    "dispatchDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "issuedBy" TEXT,
    "receivedBy" TEXT,
    "receivedAt" TIMESTAMP(3),
    "vehicleNo" TEXT,
    "notes" TEXT,
    "status" "TransferStatus" NOT NULL DEFAULT 'DISPATCHED',
    "createdById" TEXT NOT NULL,
    "cancelledAt" TIMESTAMP(3),
    "cancelledById" TEXT,
    "cancelReason" TEXT,
    "clientKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "process_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "process_transfer_lines" (
    "id" TEXT NOT NULL,
    "transferId" TEXT NOT NULL,
    "bundleId" TEXT NOT NULL,
    "sizeId" TEXT,
    "dispatchedQty" INTEGER NOT NULL,
    "receivedQty" INTEGER NOT NULL DEFAULT 0,
    "shortQty" INTEGER NOT NULL DEFAULT 0,
    "settledQty" INTEGER NOT NULL DEFAULT 0,
    "excessQty" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "process_transfer_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_work_orders" (
    "id" TEXT NOT NULL,
    "orderNumber" TEXT NOT NULL,
    "moId" TEXT NOT NULL,
    "stepId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "workstationId" TEXT,
    "rate" DECIMAL(10,2) NOT NULL,
    "plannedQty" INTEGER,
    "expectedBy" TIMESTAMP(3),
    "status" "JobWorkOrderStatus" NOT NULL DEFAULT 'OPEN',
    "notes" TEXT,
    "createdById" TEXT NOT NULL,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_work_orders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "mo_steps_moId_sequence_key" ON "mo_steps"("moId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "production_bundles_code_key" ON "production_bundles"("code");

-- CreateIndex
CREATE INDEX "production_bundles_cuttingOrderId_idx" ON "production_bundles"("cuttingOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "production_bundles_moId_bundleNo_key" ON "production_bundles"("moId", "bundleNo");

-- CreateIndex
CREATE UNIQUE INDEX "wip_events_reversalOfId_key" ON "wip_events"("reversalOfId");

-- CreateIndex
CREATE UNIQUE INDEX "wip_events_clientKey_key" ON "wip_events"("clientKey");

-- CreateIndex
CREATE INDEX "wip_events_moId_createdAt_idx" ON "wip_events"("moId", "createdAt");

-- CreateIndex
CREATE INDEX "wip_events_stepId_idx" ON "wip_events"("stepId");

-- CreateIndex
CREATE INDEX "wip_events_jobWorkOrderId_idx" ON "wip_events"("jobWorkOrderId");

-- CreateIndex
CREATE INDEX "wip_entries_moId_stepId_bucket_idx" ON "wip_entries"("moId", "stepId", "bucket");

-- CreateIndex
CREATE INDEX "wip_entries_bundleId_idx" ON "wip_entries"("bundleId");

-- CreateIndex
CREATE INDEX "wip_entries_eventId_idx" ON "wip_entries"("eventId");

-- CreateIndex
CREATE INDEX "wip_entries_vendorId_bucket_idx" ON "wip_entries"("vendorId", "bucket");

-- CreateIndex
CREATE UNIQUE INDEX "process_transfers_transferNumber_key" ON "process_transfers"("transferNumber");

-- CreateIndex
CREATE UNIQUE INDEX "process_transfers_clientKey_key" ON "process_transfers"("clientKey");

-- CreateIndex
CREATE INDEX "process_transfers_moId_idx" ON "process_transfers"("moId");

-- CreateIndex
CREATE INDEX "process_transfers_toStepId_status_idx" ON "process_transfers"("toStepId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "process_transfer_lines_transferId_bundleId_key" ON "process_transfer_lines"("transferId", "bundleId");

-- CreateIndex
CREATE UNIQUE INDEX "job_work_orders_orderNumber_key" ON "job_work_orders"("orderNumber");

-- CreateIndex
CREATE INDEX "job_work_orders_vendorId_status_idx" ON "job_work_orders"("vendorId", "status");

-- CreateIndex
CREATE INDEX "job_work_orders_moId_idx" ON "job_work_orders"("moId");

-- AddForeignKey
ALTER TABLE "manufacturing_orders" ADD CONSTRAINT "manufacturing_orders_routingId_fkey" FOREIGN KEY ("routingId") REFERENCES "routings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manufacturing_orders" ADD CONSTRAINT "manufacturing_orders_heldById_fkey" FOREIGN KEY ("heldById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cutting_orders" ADD CONSTRAINT "cutting_orders_moLineId_fkey" FOREIGN KEY ("moLineId") REFERENCES "mo_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mo_steps" ADD CONSTRAINT "mo_steps_moId_fkey" FOREIGN KEY ("moId") REFERENCES "manufacturing_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mo_steps" ADD CONSTRAINT "mo_steps_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "operations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mo_steps" ADD CONSTRAINT "mo_steps_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mo_steps" ADD CONSTRAINT "mo_steps_workstationId_fkey" FOREIGN KEY ("workstationId") REFERENCES "workstations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mo_steps" ADD CONSTRAINT "mo_steps_skippedById_fkey" FOREIGN KEY ("skippedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_bundles" ADD CONSTRAINT "production_bundles_moId_fkey" FOREIGN KEY ("moId") REFERENCES "manufacturing_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_bundles" ADD CONSTRAINT "production_bundles_moLineId_fkey" FOREIGN KEY ("moLineId") REFERENCES "mo_lines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_bundles" ADD CONSTRAINT "production_bundles_cuttingOrderId_fkey" FOREIGN KEY ("cuttingOrderId") REFERENCES "cutting_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_bundles" ADD CONSTRAINT "production_bundles_sizeId_fkey" FOREIGN KEY ("sizeId") REFERENCES "sizes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_bundles" ADD CONSTRAINT "production_bundles_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "production_bundles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wip_events" ADD CONSTRAINT "wip_events_moId_fkey" FOREIGN KEY ("moId") REFERENCES "manufacturing_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wip_events" ADD CONSTRAINT "wip_events_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "mo_steps"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wip_events" ADD CONSTRAINT "wip_events_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wip_events" ADD CONSTRAINT "wip_events_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "process_transfers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wip_events" ADD CONSTRAINT "wip_events_jobWorkOrderId_fkey" FOREIGN KEY ("jobWorkOrderId") REFERENCES "job_work_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wip_events" ADD CONSTRAINT "wip_events_cuttingOrderId_fkey" FOREIGN KEY ("cuttingOrderId") REFERENCES "cutting_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wip_events" ADD CONSTRAINT "wip_events_fgReceiptId_fkey" FOREIGN KEY ("fgReceiptId") REFERENCES "finished_goods_receipts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wip_events" ADD CONSTRAINT "wip_events_reversalOfId_fkey" FOREIGN KEY ("reversalOfId") REFERENCES "wip_events"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wip_events" ADD CONSTRAINT "wip_events_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wip_entries" ADD CONSTRAINT "wip_entries_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "wip_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wip_entries" ADD CONSTRAINT "wip_entries_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "mo_steps"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wip_entries" ADD CONSTRAINT "wip_entries_bundleId_fkey" FOREIGN KEY ("bundleId") REFERENCES "production_bundles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "process_transfers" ADD CONSTRAINT "process_transfers_moId_fkey" FOREIGN KEY ("moId") REFERENCES "manufacturing_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "process_transfers" ADD CONSTRAINT "process_transfers_fromStepId_fkey" FOREIGN KEY ("fromStepId") REFERENCES "mo_steps"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "process_transfers" ADD CONSTRAINT "process_transfers_toStepId_fkey" FOREIGN KEY ("toStepId") REFERENCES "mo_steps"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "process_transfers" ADD CONSTRAINT "process_transfers_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "process_transfers" ADD CONSTRAINT "process_transfers_jobWorkOrderId_fkey" FOREIGN KEY ("jobWorkOrderId") REFERENCES "job_work_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "process_transfers" ADD CONSTRAINT "process_transfers_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "process_transfers" ADD CONSTRAINT "process_transfers_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "process_transfer_lines" ADD CONSTRAINT "process_transfer_lines_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "process_transfers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "process_transfer_lines" ADD CONSTRAINT "process_transfer_lines_bundleId_fkey" FOREIGN KEY ("bundleId") REFERENCES "production_bundles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_work_orders" ADD CONSTRAINT "job_work_orders_moId_fkey" FOREIGN KEY ("moId") REFERENCES "manufacturing_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_work_orders" ADD CONSTRAINT "job_work_orders_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "mo_steps"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_work_orders" ADD CONSTRAINT "job_work_orders_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_work_orders" ADD CONSTRAINT "job_work_orders_workstationId_fkey" FOREIGN KEY ("workstationId") REFERENCES "workstations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_work_orders" ADD CONSTRAINT "job_work_orders_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- What each process already on file does, from its name. A check first, so
-- "Cutting QC" is a check and not a cutting.
UPDATE "operations" SET "kind" = 'QC'
 WHERE "name" ~* '(\mqc\M|quality|inspection|audit|check)';
UPDATE "operations" SET "kind" = 'CUTTING'   WHERE "kind" = 'OTHER' AND "name" ~* 'cutting';
UPDATE "operations" SET "kind" = 'STITCHING' WHERE "kind" = 'OTHER' AND "name" ~* '(stitch|sewing)';
UPDATE "operations" SET "kind" = 'FINISHING' WHERE "kind" = 'OTHER' AND "name" ~* '(finish|ironing|pressing)';
UPDATE "operations" SET "kind" = 'PACKING'   WHERE "kind" = 'OTHER' AND "name" ~* 'packing';

-- A routing step already pointed at an outside unit is done outside.
UPDATE "routing_steps" rs SET "execution" = 'OUTSOURCED'
  FROM "workstations" w
 WHERE rs."workstationId" = w."id" AND w."type" = 'JOB_WORK';
