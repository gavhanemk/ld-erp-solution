-- Size jumps at stitching: pieces of a bundle made as another size move into
-- a new bundle of that size, made from the old one. Adds the SIZE_CHANGE
-- floor entry, the step where a bundle was made from its parent, and the
-- size_changes record (who, when, why, from and to). Nothing existing changes.

-- AlterEnum
ALTER TYPE "WipEventType" ADD VALUE 'SIZE_CHANGE';

-- AlterTable
ALTER TABLE "production_bundles" ADD COLUMN     "splitAtStepId" TEXT;

-- CreateTable
CREATE TABLE "size_changes" (
    "id" TEXT NOT NULL,
    "moId" TEXT NOT NULL,
    "moLineId" TEXT NOT NULL,
    "stepId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "fromBundleId" TEXT NOT NULL,
    "toBundleId" TEXT NOT NULL,
    "fromSizeId" TEXT NOT NULL,
    "toSizeId" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "undoneAt" TIMESTAMP(3),
    "undoneById" TEXT,
    "undoReason" TEXT,

    CONSTRAINT "size_changes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "size_changes_toBundleId_key" ON "size_changes"("toBundleId");

-- CreateIndex
CREATE INDEX "size_changes_moId_idx" ON "size_changes"("moId");

-- CreateIndex
CREATE INDEX "size_changes_moLineId_idx" ON "size_changes"("moLineId");

-- CreateIndex
CREATE INDEX "size_changes_eventId_idx" ON "size_changes"("eventId");

-- CreateIndex
CREATE INDEX "size_changes_fromBundleId_idx" ON "size_changes"("fromBundleId");

-- AddForeignKey
ALTER TABLE "production_bundles" ADD CONSTRAINT "production_bundles_splitAtStepId_fkey" FOREIGN KEY ("splitAtStepId") REFERENCES "mo_steps"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "size_changes" ADD CONSTRAINT "size_changes_moId_fkey" FOREIGN KEY ("moId") REFERENCES "manufacturing_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "size_changes" ADD CONSTRAINT "size_changes_moLineId_fkey" FOREIGN KEY ("moLineId") REFERENCES "mo_lines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "size_changes" ADD CONSTRAINT "size_changes_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "mo_steps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "size_changes" ADD CONSTRAINT "size_changes_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "wip_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "size_changes" ADD CONSTRAINT "size_changes_fromBundleId_fkey" FOREIGN KEY ("fromBundleId") REFERENCES "production_bundles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "size_changes" ADD CONSTRAINT "size_changes_toBundleId_fkey" FOREIGN KEY ("toBundleId") REFERENCES "production_bundles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "size_changes" ADD CONSTRAINT "size_changes_fromSizeId_fkey" FOREIGN KEY ("fromSizeId") REFERENCES "sizes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "size_changes" ADD CONSTRAINT "size_changes_toSizeId_fkey" FOREIGN KEY ("toSizeId") REFERENCES "sizes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "size_changes" ADD CONSTRAINT "size_changes_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "size_changes" ADD CONSTRAINT "size_changes_undoneById_fkey" FOREIGN KEY ("undoneById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
