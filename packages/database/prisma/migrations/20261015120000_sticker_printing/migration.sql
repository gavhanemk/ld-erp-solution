-- Stickers are now made by themselves when stock comes in, and printed later.
ALTER TABLE "stock_packages" ADD COLUMN     "lastPrintedAt" TIMESTAMP(3),
ADD COLUMN     "printCount" INTEGER NOT NULL DEFAULT 0;

-- Every sticker made before this was printed the moment it was made.
UPDATE "stock_packages" SET "printCount" = 1, "lastPrintedAt" = "createdAt";
