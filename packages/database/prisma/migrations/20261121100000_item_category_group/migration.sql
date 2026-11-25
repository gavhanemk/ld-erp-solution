-- Items & Products in three tabs: Raw Materials, Semi-Finished Goods and
-- Finished Goods. Each main category says which it is under, and its
-- sub-categories carry the same. No item is changed: an item's tab follows
-- the category it is already filed under.

CREATE TYPE "ItemGroup" AS ENUM ('RAW_MATERIALS', 'SEMI_FINISHED', 'FINISHED_GOODS', 'EXPENSES');

ALTER TABLE "item_categories" ADD COLUMN "itemGroup" "ItemGroup" NOT NULL DEFAULT 'RAW_MATERIALS';

-- A main category goes where most of the items under it (its own and its
-- sub-categories') belong by type; an empty one by its name; anything else
-- stays under Raw Materials. Expense heads live in "Expenses" and keep their
-- own screen.
WITH under AS (
  SELECT coalesce(c."parentId", c.id) AS main, i.type
  FROM "items" i
  JOIN "item_categories" c ON c.id = i."categoryId"
),
tally AS (
  SELECT main,
    count(*) FILTER (WHERE type = 'FINISHED_GOOD') AS fg,
    count(*) FILTER (WHERE type = 'SEMI_FINISHED') AS sf,
    count(*) FILTER (WHERE type NOT IN ('FINISHED_GOOD', 'SEMI_FINISHED')) AS rm
  FROM under
  GROUP BY main
)
UPDATE "item_categories" m
SET "itemGroup" = CASE
    WHEN m.name ILIKE '%expense%' THEN 'EXPENSES'::"ItemGroup"
    WHEN coalesce(t.fg, 0) > coalesce(t.sf, 0) AND coalesce(t.fg, 0) > coalesce(t.rm, 0) THEN 'FINISHED_GOODS'::"ItemGroup"
    WHEN coalesce(t.sf, 0) > coalesce(t.fg, 0) AND coalesce(t.sf, 0) > coalesce(t.rm, 0) THEN 'SEMI_FINISHED'::"ItemGroup"
    WHEN t.main IS NULL AND m.name ILIKE 'finished%' THEN 'FINISHED_GOODS'::"ItemGroup"
    WHEN t.main IS NULL AND m.name ILIKE 'semi%' THEN 'SEMI_FINISHED'::"ItemGroup"
    ELSE 'RAW_MATERIALS'::"ItemGroup"
  END
FROM (SELECT id FROM "item_categories" WHERE "parentId" IS NULL) mains
LEFT JOIN tally t ON t.main = mains.id
WHERE m.id = mains.id;

-- Sub-categories carry their main category's.
UPDATE "item_categories" s
SET "itemGroup" = m."itemGroup"
FROM "item_categories" m
WHERE s."parentId" = m.id;

-- Semi-Finished Goods starts with a category and four process-wise
-- sub-categories (cut panels already go into stock as semi-finished items).
-- Nothing is made twice: a name already in use is left as it is.
INSERT INTO "item_categories" (id, name, "parentId", "itemGroup", "isActive", "trackPackages")
SELECT gen_random_uuid()::text, 'Semi-Finished Goods', NULL, 'SEMI_FINISHED', true, true
WHERE NOT EXISTS (SELECT 1 FROM "item_categories" WHERE "parentId" IS NULL AND "itemGroup" = 'SEMI_FINISHED')
ON CONFLICT (name) DO NOTHING;

INSERT INTO "item_categories" (id, name, "parentId", "departmentId", "itemGroup", "isActive", "trackPackages")
SELECT gen_random_uuid()::text, s.name, m.id,
  (SELECT d.id FROM "departments" d WHERE lower(d.name) = lower(s.process) LIMIT 1),
  'SEMI_FINISHED', true, true
FROM (VALUES
  ('Cut Panels', 'Cutting'),
  ('Fused Parts', 'Fusing'),
  ('Embroidered Panels', 'Embroidery'),
  ('Washed Garments', 'Washing')
) AS s(name, process)
CROSS JOIN (
  SELECT id FROM "item_categories"
  WHERE "parentId" IS NULL AND "itemGroup" = 'SEMI_FINISHED'
  ORDER BY (name = 'Semi-Finished Goods') DESC, name
  LIMIT 1
) m
ON CONFLICT (name) DO NOTHING;
