-- Routings: the fabric the garment is cut from, picked from the fabric items
-- in stock, and who made each routing and who changed it last. The code is no
-- longer typed — the API makes it — so nothing about it changes here.
--
-- Additive only: three empty columns, their index and foreign keys. Who made
-- and last changed a routing is filled from the audit log where it has a
-- record; routings seeded without one stay empty until somebody saves them.

-- AlterTable
ALTER TABLE "routings" ADD COLUMN     "createdById" TEXT,
ADD COLUMN     "fabricItemId" TEXT,
ADD COLUMN     "updatedById" TEXT;

-- CreateIndex
CREATE INDEX "routings_fabricItemId_idx" ON "routings"("fabricItemId");

-- AddForeignKey
ALTER TABLE "routings" ADD CONSTRAINT "routings_fabricItemId_fkey" FOREIGN KEY ("fabricItemId") REFERENCES "items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "routings" ADD CONSTRAINT "routings_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "routings" ADD CONSTRAINT "routings_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Who made it: the person on its CREATE entry in the audit log.
UPDATE "routings" r
SET "createdById" = a."userId"
FROM (
    SELECT DISTINCT ON ("entityId") "entityId", "userId"
    FROM "audit_logs"
    WHERE "entityType" = 'Routing' AND "action" = 'CREATE'
    ORDER BY "entityId", "createdAt" ASC
) a
WHERE a."entityId" = r."id";

-- Who changed it last: the person on its latest entry, whatever it was.
UPDATE "routings" r
SET "updatedById" = a."userId"
FROM (
    SELECT DISTINCT ON ("entityId") "entityId", "userId"
    FROM "audit_logs"
    WHERE "entityType" = 'Routing'
    ORDER BY "entityId", "createdAt" DESC
) a
WHERE a."entityId" = r."id";
