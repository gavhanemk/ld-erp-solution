-- New purchase-side documents carry the financial year, as every other
-- internal document already does: PO-2627-0001, GRN-2627-0001, ENQ-2627-0001,
-- PB-2627-0001. Documents already made keep their numbers; the new format
-- cannot collide with them, so each counter starts again from one.
--
-- Only the internal documents. Debit notes, return challans and credit/debit
-- notes are GST documents; their series is not changed in the middle of a
-- year. Only a series with no year set is touched, so one already given a
-- year in Settings is left as it is.
UPDATE "number_series" ns
SET "financialYear" = c."currentFY",
    "lastNumber" = 0
FROM "company" c
WHERE ns."companyId" = c.id
  AND ns."docType" IN ('PO', 'GRN', 'ENQ', 'PB')
  AND COALESCE(ns."financialYear", '') = ''
  AND COALESCE(c."currentFY", '') <> '';
