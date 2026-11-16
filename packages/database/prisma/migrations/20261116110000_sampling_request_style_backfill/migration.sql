-- Sampling phase 1, follow-up: requests released before they named their own style.
-- Data only and additive: a request with no style takes the one its first released
-- round was made in, as RELEASE now gives it. Without it such a request could not
-- prepare or release its next round. Touches nothing that already has a style, and
-- only styles that exist and belong to the request's brand. Where nothing was ever
-- sampled it updates no rows.
UPDATE "sample_requests" r
SET "styleId" = x."styleId"
FROM (
  SELECT DISTINCT ON ("requestId") "requestId", "specification"->>'styleId' AS "styleId"
  FROM "sample_rounds"
  WHERE "state" <> 'DRAFT' OR "releasedAt" IS NOT NULL
  ORDER BY "requestId", "revision" ASC
) x
WHERE r."id" = x."requestId"
  AND r."styleId" IS NULL
  AND COALESCE(x."styleId", '') <> ''
  AND EXISTS (SELECT 1 FROM "styles" s WHERE s."id" = x."styleId" AND s."brandId" = r."brandId");
