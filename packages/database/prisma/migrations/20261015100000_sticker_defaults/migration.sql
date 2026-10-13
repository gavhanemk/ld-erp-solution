-- Stickers are offered for every stock category unless switched off.
ALTER TABLE "item_categories" ALTER COLUMN "trackPackages" SET DEFAULT true;

-- Every stock category on. Expenses (bills, not stock) and Finished Goods
-- (they carry garment tags of their own) stay as they are.
UPDATE "item_categories" SET "trackPackages" = true
WHERE "parentId" IS NULL AND "isActive" = true AND "trackPackages" = false
  AND name NOT IN ('Expenses', 'Finished Goods');

-- An item's own sticker settings, remembered from the sticker window.
ALTER TABLE "items" ADD COLUMN     "packQty" DECIMAL(10,3),
ADD COLUMN     "packType" "PackType";

-- The document a package came in on, as printed on its sticker.
ALTER TABLE "stock_packages" ADD COLUMN     "sourceRef" TEXT;
