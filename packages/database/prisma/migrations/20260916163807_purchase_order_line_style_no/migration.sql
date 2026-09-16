-- The style number as the buyer typed it, beside the master style it links to.
--
-- One nullable column. Additive: nothing renamed, nothing dropped, and every
-- line already on the system keeps its styleId and simply has no text.

-- AlterTable
ALTER TABLE "purchase_order_lines" ADD COLUMN     "styleNo" TEXT;
