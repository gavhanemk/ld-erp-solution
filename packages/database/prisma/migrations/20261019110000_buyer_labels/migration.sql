-- Buyer stickers: the barcode sticker a buyer's brand wants on goods made for
-- them (SleepZ for Raymond Lifestyle): their brand, who markets it, the
-- consumer-complaints lines, the barcode pattern — kept on the customer — and
-- each order line's article, colour code, product, MRP and pieces per pack.
-- Additive only: two optional columns.

-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "labelProfile" JSONB;

-- AlterTable
ALTER TABLE "sales_order_lines" ADD COLUMN     "labelInfo" JSONB;
