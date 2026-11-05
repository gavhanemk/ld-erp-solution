-- Purchase charges carry their own GST, and "Other Charges" becomes a charge.
--
-- Two changes, neither of which rewrites a figure already saved.
--
-- 1. A purchase order line's discount is a percentage with up to six decimals.
--    A buyer types a discount in rupees as often as in percent, and the form
--    turns the rupees into a percent of the line. Kept to two decimals that
--    percent no longer gives back the rupees that were typed — ₹100 off
--    ₹3,333 is 3.000300%, which two decimals would store as 3.00% and print
--    as ₹99.99. Widening the column only adds places; every value already
--    stored reads exactly as before.
--
-- 2. A charge type named "Other Charges", so the old untaxed "Other charges"
--    box on the purchase order can be replaced by a charge that carries a GST
--    rate like freight or packing does. Added only when the mill has no charge
--    type of that name already — matched with the case and the spaces taken
--    out, so "Other charges" or "OTHERCHARGES" typed into the master by hand
--    counts as the same thing and no second one is made. Re-running it is
--    harmless. 18% is only where a new charge of this kind starts; the order
--    form offers the goods' own rate first and the buyer sets the figure.
--
-- Orders saved before this keep their stored "Other charges" amount, and their
-- totals, until somebody edits them.

-- AlterTable
ALTER TABLE "purchase_order_lines" ALTER COLUMN "discount" TYPE DECIMAL(9,6);

-- Seed
INSERT INTO "charge_types" (
  "id", "name", "defaultGstRate", "percentOfValue",
  "applyOnSale", "applyOnPurchase", "isActive", "createdAt"
)
SELECT
  'ct_other_charges',
  'Other Charges',
  18,
  0,
  false,
  true,
  true,
  CURRENT_TIMESTAMP
WHERE NOT EXISTS (
  SELECT 1 FROM "charge_types" ct
  WHERE lower(replace(ct."name", ' ', '')) = 'othercharges'
);
