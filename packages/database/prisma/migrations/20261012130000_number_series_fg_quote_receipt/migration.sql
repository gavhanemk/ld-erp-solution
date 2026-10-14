-- Numbering for three documents that took their numbers from series nothing
-- ever set up, so they failed on any install where somebody had not added the
-- series by hand in Settings: packed garments into the finished-goods store
-- (FGR), quotations (QT) and a buyer's payment in (RCPT). Written for every
-- company that has none yet, so re-running it is harmless.
INSERT INTO "number_series" (
  "id", "companyId", "docType", "prefix", "separator",
  "financialYear", "lastNumber", "padding", "isActive"
)
SELECT
  gen_random_uuid()::text,
  c."id",
  d."docType",
  d."docType",
  '-',
  COALESCE(NULLIF(c."currentFY", ''), '2627'),
  0,
  4,
  true
FROM "company" c
CROSS JOIN (VALUES ('FGR'), ('QT'), ('RCPT')) AS d("docType")
WHERE NOT EXISTS (
  SELECT 1 FROM "number_series" ns
  WHERE ns."companyId" = c."id" AND ns."docType" = d."docType"
);
