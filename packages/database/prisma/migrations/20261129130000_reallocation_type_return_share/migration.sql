-- AlterEnum
ALTER TYPE "TransactionType" ADD VALUE 'REALLOCATION';

-- AlterTable
ALTER TABLE "floor_return_lines" ADD COLUMN     "brandId" TEXT;

-- AddForeignKey
ALTER TABLE "floor_return_lines" ADD CONSTRAINT "floor_return_lines_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "brands"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

