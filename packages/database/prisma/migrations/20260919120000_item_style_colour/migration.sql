-- Links a finished-goods item to the style and colour it sells as, so a
-- manufacturing order or invoice can resolve "this style in this colour" as
-- one item instead of matching free text. Required for FINISHED_GOOD items,
-- forbidden otherwise, and the colour must be one of the style's own
-- colors[] -- both rules enforced in the API (see assertItemStyleColorValid),
-- not here, because "one of this style's colours" needs a lookup a database
-- constraint can't express.

-- AlterTable
ALTER TABLE "items" ADD COLUMN     "styleId" TEXT,
ADD COLUMN     "color" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "items_styleId_color_key" ON "items"("styleId", "color");

-- AddForeignKey
ALTER TABLE "items" ADD CONSTRAINT "items_styleId_fkey" FOREIGN KEY ("styleId") REFERENCES "styles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
