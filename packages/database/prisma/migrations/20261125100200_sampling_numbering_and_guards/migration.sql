-- Existing companies need a sample series too; preserve any series already configured.
INSERT INTO number_series (id, "companyId", "docType", prefix, separator, "financialYear", "lastNumber", padding, "isActive")
SELECT 'sample-series-' || md5(c.id), c.id, 'SAMPLE', 'SMP', '-', COALESCE(c."currentFY", ''), 0, 4, true
FROM company c
WHERE NOT EXISTS (SELECT 1 FROM number_series n WHERE n."companyId"=c.id AND n."docType"='SAMPLE');

ALTER TABLE sample_materials ADD CONSTRAINT sample_material_nonnegative CHECK (
  "plannedQty">0 AND "issuedQty">=0 AND "returnedQty">=0 AND "usedQty">=0 AND "wasteQty">=0
  AND "issuedQty"<="plannedQty" AND "returnedQty"+"usedQty"+"wasteQty"<="issuedQty"
);
ALTER TABLE sample_rounds ADD CONSTRAINT sample_round_state CHECK (state IN ('DRAFT','RELEASED','QC_PASSED','SUBMITTED','APPROVED','CHANGES_REQUIRED','REJECTED'));
ALTER TABLE sample_requests ADD CONSTRAINT sample_request_state CHECK (state IN ('DRAFT','RELEASED','QC_PASSED','SUBMITTED','APPROVED','CHANGES_REQUIRED','REJECTED','CANCELLED'));
