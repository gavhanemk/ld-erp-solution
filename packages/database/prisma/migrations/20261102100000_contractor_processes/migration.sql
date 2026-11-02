-- A contractor can take on more than one process: their processes become a
-- list. Each contractor already there keeps the one process they had.
ALTER TABLE "contractors" ADD COLUMN "operationIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
UPDATE "contractors" SET "operationIds" = ARRAY["operationId"] WHERE "operationId" IS NOT NULL;

ALTER TABLE "contractors" DROP CONSTRAINT "contractors_operationId_fkey";
DROP INDEX "contractors_operationId_idx";
ALTER TABLE "contractors" DROP COLUMN "operationId";

CREATE INDEX "contractors_operationIds_idx" ON "contractors" USING GIN ("operationIds");
