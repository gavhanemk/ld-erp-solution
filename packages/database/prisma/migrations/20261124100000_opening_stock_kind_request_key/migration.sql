-- Opening stock: the type an entry was made as (FG, SFG, RM), and the key a save is sent with,
-- so a save sent twice finds its entry instead of posting twice. Additions only.
-- AlterTable
ALTER TABLE "opening_stocks" ADD COLUMN     "kind" TEXT,
ADD COLUMN     "requestKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "opening_stocks_requestKey_key" ON "opening_stocks"("requestKey");
