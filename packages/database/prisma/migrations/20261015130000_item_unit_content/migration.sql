-- What one unit of an item holds, printed on its stickers: 1 box · 144 pcs.
ALTER TABLE "items" ADD COLUMN     "contentQty" DECIMAL(12,3),
ADD COLUMN     "contentUnit" TEXT;
