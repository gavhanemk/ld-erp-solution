-- Sampling phase 6: QC colour by colour, sending to the buyer on a Sample
-- Delivery Challan, and the buyer's decision colour by colour.
-- Only sample_* tables change, one new table, and one number series.

-- A round whose QC failed has a state of its own (it was left "being made").
ALTER TABLE sample_rounds DROP CONSTRAINT sample_round_state;
ALTER TABLE sample_rounds ADD CONSTRAINT sample_round_state CHECK (state IN ('DRAFT','RELEASED','QC_FAILED','QC_PASSED','SUBMITTED','APPROVED','CHANGES_REQUIRED','REJECTED'));
ALTER TABLE sample_requests DROP CONSTRAINT sample_request_state;
ALTER TABLE sample_requests ADD CONSTRAINT sample_request_state CHECK (state IN ('DRAFT','RELEASED','QC_FAILED','QC_PASSED','SUBMITTED','APPROVED','CHANGES_REQUIRED','REJECTED','CANCELLED'));

UPDATE sample_rounds SET state = 'QC_FAILED'
WHERE state = 'RELEASED' AND qc IS NOT NULL AND qc->>'passed' = 'false';
-- A request reads as its latest round.
UPDATE sample_requests r SET state = 'QC_FAILED'
WHERE r.state = 'RELEASED' AND EXISTS (
  SELECT 1 FROM sample_rounds x
  WHERE x."requestId" = r.id AND x.state = 'QC_FAILED'
    AND x.revision = (SELECT max(y.revision) FROM sample_rounds y WHERE y."requestId" = r.id)
);

-- The Sample Delivery Challan's own series; any series already set up is kept.
INSERT INTO number_series (id, "companyId", "docType", prefix, separator, "financialYear", "lastNumber", padding, "isActive")
SELECT 'sample-dispatch-series-' || md5(c.id), c.id, 'SDC', 'SDC', '-', COALESCE(c."currentFY", ''), 0, 4, true
FROM company c
WHERE NOT EXISTS (SELECT 1 FROM number_series n WHERE n."companyId"=c.id AND n."docType"='SDC');

-- CreateTable: sample pieces sent to the buyer.
CREATE TABLE "sample_dispatches" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "roundId" TEXT NOT NULL,
    "cells" JSONB NOT NULL,
    "recipient" TEXT NOT NULL,
    "address" TEXT,
    "mode" TEXT NOT NULL,
    "courier" TEXT,
    "awb" TEXT,
    "sentOn" TIMESTAMP(3) NOT NULL,
    "returnable" BOOLEAN NOT NULL DEFAULT false,
    "expectedBack" TIMESTAMP(3),
    "declaredValue" DECIMAL(12,2),
    "courierCharge" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelledAt" TIMESTAMP(3),
    "cancelledBy" TEXT,
    "cancelReason" TEXT,

    CONSTRAINT "sample_dispatches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sample_dispatches_number_key" ON "sample_dispatches"("number");

-- CreateIndex
CREATE INDEX "sample_dispatches_roundId_idx" ON "sample_dispatches"("roundId");

-- AddForeignKey
ALTER TABLE "sample_dispatches" ADD CONSTRAINT "sample_dispatches_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "sample_rounds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The challan's own shape; what may be sent (no more than passed QC) is the service's.
ALTER TABLE sample_dispatches ADD CONSTRAINT sample_dispatch_shape CHECK (
  jsonb_typeof("cells") = 'array'
  AND "mode" IN ('COURIER','HAND','TRANSPORT')
  AND "courierCharge" >= 0
  AND ("declaredValue" IS NULL OR "declaredValue" >= 0)
  AND ("returnable" OR "expectedBack" IS NULL)
  AND ("cancelledAt" IS NULL) = ("cancelReason" IS NULL)
);
