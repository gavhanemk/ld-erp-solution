-- Items & Products in three categories only: Raw Materials, Semi-Finished
-- Goods and Finished Goods. Every other main category becomes a sub-category
-- under the one for its tab (Fabric under Raw Materials), and the
-- sub-categories it held are folded into it: their items move up to it and
-- they are switched off, kept for the record. No item's code, name or
-- department changes, and every move is written to the audit log. The
-- expense heads keep their own "Expenses" category.

-- 1. The three, as main categories of their own tabs.
INSERT INTO "item_categories" (id, name, "parentId", "itemGroup", "isActive", "trackPackages")
SELECT gen_random_uuid()::text, v.name, NULL, v.grp::"ItemGroup", true, true
FROM (VALUES
  ('Raw Materials', 'RAW_MATERIALS'),
  ('Semi-Finished Goods', 'SEMI_FINISHED'),
  ('Finished Goods', 'FINISHED_GOODS')
) AS v(name, grp)
ON CONFLICT (name) DO NOTHING;

UPDATE "item_categories" c
SET "parentId" = NULL, "itemGroup" = v.grp::"ItemGroup", "isActive" = true
FROM (VALUES
  ('Raw Materials', 'RAW_MATERIALS'),
  ('Semi-Finished Goods', 'SEMI_FINISHED'),
  ('Finished Goods', 'FINISHED_GOODS')
) AS v(name, grp)
WHERE c.name = v.name;

-- 2. Every other main category (not the expense heads') and the one of the
-- three it goes under.
CREATE TEMP TABLE fold ON COMMIT DROP AS
SELECT m.id AS main_id, m.name AS main_name, top.id AS top_id, top.name AS top_name
FROM "item_categories" m
JOIN "item_categories" top
  ON top."parentId" IS NULL
 AND top.name = CASE m."itemGroup"
                  WHEN 'RAW_MATERIALS' THEN 'Raw Materials'
                  WHEN 'SEMI_FINISHED' THEN 'Semi-Finished Goods'
                  WHEN 'FINISHED_GOODS' THEN 'Finished Goods'
                END
WHERE m."parentId" IS NULL
  AND m."itemGroup" <> 'EXPENSES'
  AND m.name NOT IN ('Raw Materials', 'Semi-Finished Goods', 'Finished Goods');

-- 3. Each item moving up from a folded sub-category, in the audit log first:
-- the item's history says where it was and where it went.
INSERT INTO "audit_logs" (id, "userId", module, action, "entityType", "entityId", before, after, "createdAt")
SELECT gen_random_uuid()::text, u.id, 'masters', 'UPDATE', 'Item', i.id,
  jsonb_build_object('categoryId', s.id, 'category', f.main_name || ' / ' || s.name),
  jsonb_build_object(
    'categoryId', f.main_id,
    'category', f.top_name || ' / ' || f.main_name,
    'note', 'Items & Products in three categories: ' || s.name || ' folded into ' || f.main_name
  ),
  now()
FROM "items" i
JOIN "item_categories" s ON s.id = i."categoryId"
JOIN fold f ON f.main_id = s."parentId"
CROSS JOIN (SELECT id FROM "users" ORDER BY "createdAt" LIMIT 1) u;

-- 4. A folded category with no department or package of its own takes the one
-- most of its items were filed under (Fabric: Cutting, rolls).
UPDATE "item_categories" m
SET "departmentId" = (
  SELECT s."departmentId"
  FROM "item_categories" s
  LEFT JOIN "items" i ON i."categoryId" = s.id
  WHERE s."parentId" = m.id AND s."departmentId" IS NOT NULL
  GROUP BY s."departmentId"
  ORDER BY count(i.id) DESC, count(DISTINCT s.id) DESC
  LIMIT 1
)
WHERE m.id IN (SELECT main_id FROM fold) AND m."departmentId" IS NULL;

UPDATE "item_categories" m
SET "packType" = (
  SELECT s."packType"
  FROM "item_categories" s
  LEFT JOIN "items" i ON i."categoryId" = s.id
  WHERE s."parentId" = m.id AND s."packType" IS NOT NULL
  GROUP BY s."packType"
  ORDER BY count(i.id) DESC, count(DISTINCT s.id) DESC
  LIMIT 1
)
WHERE m.id IN (SELECT main_id FROM fold) AND m."packType" IS NULL;

-- 5. The items move up.
UPDATE "items" i
SET "categoryId" = s."parentId", "updatedAt" = now()
FROM "item_categories" s
JOIN fold f ON f.main_id = s."parentId"
WHERE i."categoryId" = s.id;

-- 6. The folded sub-categories are switched off, kept under their old parent.
UPDATE "item_categories" s
SET "isActive" = false
FROM fold f
WHERE s."parentId" = f.main_id;

-- 7. Each folded category becomes a sub-category of its tab's.
UPDATE "item_categories" m
SET "parentId" = f.top_id, "itemGroup" = top."itemGroup"
FROM fold f
JOIN "item_categories" top ON top.id = f.top_id
WHERE m.id = f.main_id;
