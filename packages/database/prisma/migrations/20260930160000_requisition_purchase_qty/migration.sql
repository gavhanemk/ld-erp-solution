-- How much of a requisition line the store has decided to buy.
--
-- Until now a line was either issued from the rack or bought whole. The store
-- could not issue part and buy the rest, buy the whole with some on the rack
-- kept back, or buy more than asked with the extra going into stock.
--
-- One nullable column; no existing row is touched. Null on lines decided
-- before this, where PURCHASE meant the whole quantity asked for — the API
-- reads it that way. Written by hand, as the recent ones, because the live
-- database carries tables from unmerged branches that `migrate dev` would drop.
-- No DROP, no DELETE, no TRUNCATE.

ALTER TABLE "material_requisition_lines" ADD COLUMN "purchaseQty" DECIMAL(10,3);
