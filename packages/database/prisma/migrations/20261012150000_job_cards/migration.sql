-- Job cards: one per manufacturing-order line, as the floor works it.
CREATE TABLE "job_cards" (
    "id" TEXT NOT NULL,
    "jobCardNumber" TEXT NOT NULL,
    "moId" TEXT NOT NULL,
    "moLineId" TEXT NOT NULL,
    "orderNo" TEXT,
    "projectId" TEXT,
    "description" TEXT,
    "fabricQuality" TEXT,
    "designNo" TEXT,
    "lotNo" TEXT,
    "meters" DECIMAL(12,3),
    "average" DECIMAL(10,4),
    "ratio" TEXT,
    "notes" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_cards_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "job_cards_jobCardNumber_key" ON "job_cards"("jobCardNumber");
CREATE UNIQUE INDEX "job_cards_moLineId_key" ON "job_cards"("moLineId");
CREATE INDEX "job_cards_moId_idx" ON "job_cards"("moId");

ALTER TABLE "job_cards" ADD CONSTRAINT "job_cards_moId_fkey" FOREIGN KEY ("moId") REFERENCES "manufacturing_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "job_cards" ADD CONSTRAINT "job_cards_moLineId_fkey" FOREIGN KEY ("moLineId") REFERENCES "mo_lines"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "job_cards" ADD CONSTRAINT "job_cards_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A job card's issue to cutting comes from no step and carries sizes, not bundles.
ALTER TABLE "process_transfers" ALTER COLUMN "fromStepId" DROP NOT NULL;
ALTER TABLE "process_transfers" ADD COLUMN "jobCardId" TEXT;
CREATE INDEX "process_transfers_jobCardId_idx" ON "process_transfers"("jobCardId");
ALTER TABLE "process_transfers" ADD CONSTRAINT "process_transfers_jobCardId_fkey" FOREIGN KEY ("jobCardId") REFERENCES "job_cards"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "process_transfer_lines" ALTER COLUMN "bundleId" DROP NOT NULL;

-- Orders already on the floor get their job cards now, one per line, with
-- what the sales order says of the line.
INSERT INTO "job_cards" ("id", "jobCardNumber", "moId", "moLineId", "orderNo", "projectId", "description", "fabricQuality", "designNo", "createdById", "createdAt", "updatedAt")
SELECT
    'jc' || substr(md5(l."id"), 1, 23),
    m."moNumber" || '-JC' || row_number() OVER (PARTITION BY m."id" ORDER BY l."id"),
    m."id",
    l."id",
    so."customerPORef",
    so."reference",
    sol."description",
    sol."fabric",
    sol."printName",
    m."createdById",
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "mo_lines" l
JOIN "manufacturing_orders" m ON m."id" = l."moId"
LEFT JOIN "sales_orders" so ON so."id" = m."soId"
LEFT JOIN "sales_order_lines" sol ON sol."id" = l."soLineId"
WHERE m."status" NOT IN ('DRAFT', 'CLOSED')
  AND EXISTS (SELECT 1 FROM "mo_steps" s WHERE s."moId" = m."id");

-- Their transfers are filed under them.
UPDATE "process_transfers" t
SET "jobCardId" = jc."id"
FROM "job_cards" jc
WHERE t."jobCardId" IS NULL
  AND jc."moLineId" = (
      SELECT b."moLineId" FROM "process_transfer_lines" pl
      JOIN "production_bundles" b ON b."id" = pl."bundleId"
      WHERE pl."transferId" = t."id"
      LIMIT 1
  );
