-- AlterTable
ALTER TABLE "grn_lines" ADD COLUMN     "packQtys" DECIMAL(10,3)[] DEFAULT ARRAY[]::DECIMAL(10,3)[],
ADD COLUMN     "packType" "PackType";

