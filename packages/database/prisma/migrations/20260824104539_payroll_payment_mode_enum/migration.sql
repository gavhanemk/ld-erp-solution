/*
  Warnings:

  - The `paymentMode` column on the `payroll_records` table would be dropped and recreated. This will lead to data loss if there is data in the column.

*/
-- AlterTable
ALTER TABLE "payroll_records" DROP COLUMN "paymentMode",
ADD COLUMN     "paymentMode" "PaymentMode";
