-- Routing: start and stop, by hand, for each style's steps.
--
-- Masters → Routings now opens on the styles. Each style's page shows its
-- routing's steps with a Start and a Stop button; this table keeps when each
-- was pressed and by whom, and a step left out with why. One row per style per
-- process (`occurrence` tells apart a process that appears twice on a route).
--
-- Keyed by process rather than by routing step on purpose: saving a routing
-- writes its steps afresh, so a link to a step would be lost on the next edit.
--
-- A new table only. Nothing existing is changed, so the running app is not
-- affected. Written by hand and applied with `prisma migrate deploy`.

-- CreateTable
CREATE TABLE "style_step_runs" (
    "id" TEXT NOT NULL,
    "styleId" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "occurrence" INTEGER NOT NULL DEFAULT 1,
    "routingId" TEXT,
    "routingVersion" INTEGER,
    "stepName" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "startedAt" TIMESTAMP(3),
    "startedById" TEXT,
    "stoppedAt" TIMESTAMP(3),
    "stoppedById" TEXT,
    "skippedAt" TIMESTAMP(3),
    "skippedById" TEXT,
    "skipReason" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "style_step_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "style_step_runs_styleId_idx" ON "style_step_runs"("styleId");

-- CreateIndex
CREATE UNIQUE INDEX "style_step_runs_styleId_operationId_occurrence_key" ON "style_step_runs"("styleId", "operationId", "occurrence");

-- AddForeignKey
ALTER TABLE "style_step_runs" ADD CONSTRAINT "style_step_runs_styleId_fkey" FOREIGN KEY ("styleId") REFERENCES "styles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "style_step_runs" ADD CONSTRAINT "style_step_runs_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "operations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "style_step_runs" ADD CONSTRAINT "style_step_runs_routingId_fkey" FOREIGN KEY ("routingId") REFERENCES "routings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "style_step_runs" ADD CONSTRAINT "style_step_runs_startedById_fkey" FOREIGN KEY ("startedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "style_step_runs" ADD CONSTRAINT "style_step_runs_stoppedById_fkey" FOREIGN KEY ("stoppedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "style_step_runs" ADD CONSTRAINT "style_step_runs_skippedById_fkey" FOREIGN KEY ("skippedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
