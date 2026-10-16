-- The mill's in-between checks are not steps of their own (16 Oct 2026):
-- Cutting QC, Embroidery QC, Stitching Line QC and Line QC come off every
-- routing and are switched off in the Processes master. Final QC stays.
--
-- A routing that loses a step gets a new version, as saving it in Masters →
-- Routings would, and a dated note saying why. Orders keep the copy of the
-- steps they were given, and nothing on the floor or in the style tracker is
-- deleted. Run again, it finds nothing left to do.

-- The routings that have such a step: a new version, with the reason.
UPDATE "ld_erp"."routings" r
SET "version" = r."version" + 1,
    "updatedAt" = now(),
    "updatedById" = NULL,
    "notes" = trim(concat_ws(E'\n', nullif(r."notes", ''), '16 Oct 2026: the QC steps (Cutting QC, Embroidery QC, Stitching Line QC, Line QC) were taken off; Final QC stays.'))
WHERE EXISTS (
  SELECT 1 FROM "ld_erp"."routing_steps" s
  JOIN "ld_erp"."operations" o ON o."id" = s."operationId"
  WHERE s."routingId" = r."id"
    AND (o."code" IN ('OP-CUTQC', 'OP-EMBQC', 'OP-STILQC', 'OP-LINEQC')
         OR lower(o."name") IN ('cutting qc', 'embroidery qc', 'stitching line qc', 'stiching line qc', 'line qc'))
);

-- Their steps out of the way of the renumbering below: (routing, sequence) is unique.
UPDATE "ld_erp"."routing_steps" s
SET "sequence" = s."sequence" + 10000
WHERE s."routingId" IN (
  SELECT s2."routingId" FROM "ld_erp"."routing_steps" s2
  JOIN "ld_erp"."operations" o ON o."id" = s2."operationId"
  WHERE o."code" IN ('OP-CUTQC', 'OP-EMBQC', 'OP-STILQC', 'OP-LINEQC')
     OR lower(o."name") IN ('cutting qc', 'embroidery qc', 'stitching line qc', 'stiching line qc', 'line qc')
);

-- The checks come off.
DELETE FROM "ld_erp"."routing_steps" s
USING "ld_erp"."operations" o
WHERE o."id" = s."operationId"
  AND (o."code" IN ('OP-CUTQC', 'OP-EMBQC', 'OP-STILQC', 'OP-LINEQC')
       OR lower(o."name") IN ('cutting qc', 'embroidery qc', 'stitching line qc', 'stiching line qc', 'line qc'));

-- The steps left are numbered 1, 2, 3… again, in the order they were.
UPDATE "ld_erp"."routing_steps" s
SET "sequence" = n.rn
FROM (
  SELECT "id", row_number() OVER (PARTITION BY "routingId" ORDER BY "sequence") AS rn
  FROM "ld_erp"."routing_steps"
  WHERE "routingId" IN (SELECT "routingId" FROM "ld_erp"."routing_steps" WHERE "sequence" > 10000)
) n
WHERE n."id" = s."id";

-- And the processes are switched off: not offered on routings any more.
UPDATE "ld_erp"."operations"
SET "isActive" = false
WHERE "code" IN ('OP-CUTQC', 'OP-EMBQC', 'OP-STILQC', 'OP-LINEQC')
   OR lower("name") IN ('cutting qc', 'embroidery qc', 'stitching line qc', 'stiching line qc', 'line qc');
