-- Quantity precision per unit, and per item where it differs.
-- 0 = whole numbers only; up to 3 = the stock columns' own precision.
ALTER TABLE "ld_erp"."uom" ADD COLUMN "decimalPlaces" INTEGER NOT NULL DEFAULT 3;
ALTER TABLE "ld_erp"."uom" ADD CONSTRAINT "uom_decimalPlaces_range" CHECK ("decimalPlaces" BETWEEN 0 AND 3);

ALTER TABLE "ld_erp"."items" ADD COLUMN "decimalPlaces" INTEGER;
ALTER TABLE "ld_erp"."items" ADD CONSTRAINT "items_decimalPlaces_range" CHECK ("decimalPlaces" IS NULL OR "decimalPlaces" BETWEEN 0 AND 3);

-- Things that only come whole. Metres, kilograms, grams, litres and rolls keep
-- decimals; any unit can be switched later on the Units master.
UPDATE "ld_erp"."uom" SET "decimalPlaces" = 0
 WHERE lower("symbol") IN ('pcs', 'pc', 'nos', 'no', 'box', 'boxes', 'ctn', 'carton', 'set', 'sets', 'pair', 'pairs', 'pr', 'doz', 'dozen', 'grs', 'gross', 'pkt', 'packet')
    OR lower("name") IN ('piece', 'pieces', 'number', 'numbers', 'box', 'boxes', 'carton', 'cartons', 'set', 'sets', 'pair', 'pairs', 'dozen', 'gross', 'packet', 'packets');
