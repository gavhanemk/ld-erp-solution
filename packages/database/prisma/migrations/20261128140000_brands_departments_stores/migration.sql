-- Brand master: a code (what the brand's style codes start with), the own
-- brand B2B and job work go under (the default), and where its finished goods
-- come in by default.
ALTER TABLE "brands" ADD COLUMN "code" TEXT;
ALTER TABLE "brands" ADD COLUMN "isDefault" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "brands" ADD COLUMN "defaultWarehouseId" TEXT;
ALTER TABLE "brands" ADD CONSTRAINT "brands_defaultWarehouseId_fkey" FOREIGN KEY ("defaultWarehouseId") REFERENCES "warehouses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Each brand's code is what its style codes already start with: a short
-- first word whole (LD Cotton Mills → LD), else its first two letters
-- (VHAGAR → VH, Stich Code → ST). A second brand on the same letters gets a
-- number (ST2), oldest first.
WITH words AS (
  SELECT id, "createdAt", regexp_split_to_array(trim(regexp_replace(upper(name), '[^A-Z0-9]+', ' ', 'g')), ' ') AS w
  FROM "brands"
), base AS (
  SELECT id, "createdAt",
    CASE
      WHEN w[1] IS NULL OR w[1] = '' THEN 'BR'
      WHEN array_length(w, 1) > 1 AND length(w[1]) <= 3 THEN w[1]
      ELSE left(w[1], 2)
    END AS stem
  FROM words
), numbered AS (
  SELECT id, stem, row_number() OVER (PARTITION BY stem ORDER BY "createdAt", id) AS n FROM base
)
UPDATE "brands" b SET "code" = CASE WHEN numbered.n = 1 THEN numbered.stem ELSE numbered.stem || numbered.n END
FROM numbered WHERE numbered.id = b.id;
CREATE UNIQUE INDEX "brands_code_key" ON "brands"("code");

-- The default brand: LD Cotton Mills by name, else the oldest of that kind.
UPDATE "brands" SET "isDefault" = true WHERE id = (
  SELECT id FROM "brands" WHERE type = 'LD_COTTON_MILLS' AND "isActive"
  ORDER BY (name ILIKE '%ld%cotton%') DESC, "createdAt" ASC
  LIMIT 1
);
-- Only ever one.
CREATE UNIQUE INDEX "brands_one_default" ON "brands"("isDefault") WHERE "isDefault";

-- Profit centres (the brand tags on accounts lines): a code, the brand's, and a description.
ALTER TABLE "cost_centres" ADD COLUMN "code" TEXT;
ALTER TABLE "cost_centres" ADD COLUMN "description" TEXT;
UPDATE "cost_centres" c SET "code" = b."code" FROM "brands" b WHERE b.id = c."brandId";
CREATE UNIQUE INDEX "cost_centres_code_key" ON "cost_centres"("code");

-- Departments, the cost centres, roll up into a parent.
ALTER TABLE "departments" ADD COLUMN "parentId" TEXT;
ALTER TABLE "departments" ADD CONSTRAINT "departments_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- What kind of place each store is. A process floor is work in progress, a
-- sample store holds samples; every other store says GENERAL until set.
CREATE TYPE "WarehouseKind" AS ENUM ('GENERAL', 'RAW_MATERIAL', 'WIP', 'FINISHED_GOODS', 'QC_HOLD', 'REJECTED', 'SCRAP', 'JOB_WORK', 'TRANSIT', 'SAMPLE');
ALTER TABLE "warehouses" ADD COLUMN "kind" "WarehouseKind" NOT NULL DEFAULT 'GENERAL';
UPDATE "warehouses" SET "kind" = 'WIP' WHERE "departmentId" IS NOT NULL;
UPDATE "warehouses" SET "kind" = 'SAMPLE' WHERE purpose = 'SAMPLING' AND "departmentId" IS NULL;
