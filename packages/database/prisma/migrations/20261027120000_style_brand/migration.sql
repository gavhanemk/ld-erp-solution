-- A style is made under a brand from the Brands master, as sales orders,
-- quotations and manufacturing orders already are; brandType stays and
-- follows from that brand's kind. Additive only.
ALTER TABLE "styles" ADD COLUMN "brandId" TEXT;

CREATE INDEX "styles_brandId_idx" ON "styles"("brandId");

ALTER TABLE "styles" ADD CONSTRAINT "styles_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "brands"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Styles already there: the first brand made of their kind, the brand they
-- were made for (LD Cotton Mills, VHAGAR).
UPDATE "styles" AS s
SET "brandId" = b.id
FROM (
  SELECT DISTINCT ON ("type") id, "type"
  FROM "brands"
  ORDER BY "type", "createdAt", id
) AS b
WHERE s."brandId" IS NULL AND b."type" = s."brandType";
