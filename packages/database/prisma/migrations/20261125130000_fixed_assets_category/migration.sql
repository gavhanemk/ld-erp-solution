-- Fixed assets (25 Nov 2026): the fourth main category, beside Raw Materials,
-- Semi-Finished Goods and Finished Goods. Every asset is tagged: one sticker
-- each, so its category tracks by package.

-- A category already named so, filed under another and holding nothing yet, becomes the main one.
UPDATE "item_categories" c
SET "parentId" = NULL, "itemGroup" = 'FIXED_ASSETS', "trackPackages" = true, "packType" = COALESCE(c."packType", 'OTHER')
WHERE lower(c."name") = 'fixed assets'
  AND NOT EXISTS (SELECT 1 FROM "items" i WHERE i."categoryId" = c."id");

-- Otherwise it is made.
INSERT INTO "item_categories" ("id", "name", "parentId", "isActive", "trackPackages", "packType", "itemGroup")
SELECT gen_random_uuid()::text, 'Fixed Assets', NULL, true, true, 'OTHER', 'FIXED_ASSETS'
WHERE NOT EXISTS (SELECT 1 FROM "item_categories" WHERE lower("name") = 'fixed assets');
