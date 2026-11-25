ALTER TABLE "routings" ADD COLUMN "creationKey" TEXT, ADD COLUMN "copiedFrom" JSONB;
CREATE UNIQUE INDEX "routings_creationKey_key" ON "routings"("creationKey");
CREATE INDEX "routing_steps_operationId_idx" ON "routing_steps"("operationId");
