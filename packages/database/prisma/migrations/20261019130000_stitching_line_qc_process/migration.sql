-- The processes of the old ERP's list that the Processes master lacked.
-- Every other one is there already under its own spelling (Cutting QC,
-- Embroidery QC, Job Work, Kaj Button); only Stitching Line QC was missing.
-- It is a check the stitching department makes on its own line. Added only
-- when no process of that name exists; nothing is put on any routing — the
-- routing decides which processes an order goes through.
INSERT INTO "ld_erp"."operations" ("id", "departmentId", "name", "code", "sortOrder", "isActive", "kind", "defaultExecution")
SELECT 'op_' || replace(gen_random_uuid()::text, '-', ''), d."id", 'Stitching Line QC', 'OP-STILQC', 65, true,
       'QC'::"ld_erp"."ProcessKind", 'IN_HOUSE'::"ld_erp"."StepExecution"
FROM "ld_erp"."departments" d
WHERE d."code" = 'STI'
  AND NOT EXISTS (
    SELECT 1 FROM "ld_erp"."operations" o
    WHERE lower(o."name") IN ('stitching line qc', 'stiching line qc') OR o."code" = 'OP-STILQC'
  );
