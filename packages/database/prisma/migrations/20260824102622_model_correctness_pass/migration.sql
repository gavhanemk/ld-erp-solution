/*
  Warnings:

  - The `status` column on the `cutting_orders` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - You are about to drop the column `uom` on the `delivery_challan_lines` table. All the data in the column will be lost.
  - The `status` column on the `delivery_challans` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The `status` column on the `grn` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The `status` column on the `machine_breakdowns` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The `status` column on the `machines` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The `status` column on the `maintenance_schedules` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - You are about to drop the column `department` on the `material_requisitions` table. All the data in the column will be lost.
  - You are about to drop the column `sizeBreakup` on the `mo_lines` table. All the data in the column will be lost.
  - The `status` column on the `packing_orders` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - You are about to drop the column `department` on the `production_entries` table. All the data in the column will be lost.
  - You are about to drop the column `lineNumber` on the `production_entries` table. All the data in the column will be lost.
  - The `status` column on the `purchase_invoices` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The `status` column on the `sales_invoices` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - You are about to drop the column `sizeBreakup` on the `sales_order_lines` table. All the data in the column will be lost.
  - You are about to drop the column `sizeSet` on the `styles` table. All the data in the column will be lost.
  - Added the required column `uomId` to the `delivery_challan_lines` table without a default value. This is not possible if the table is not empty.
  - Added the required column `departmentId` to the `material_requisitions` table without a default value. This is not possible if the table is not empty.
  - Added the required column `departmentId` to the `production_entries` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('UNPAID', 'PARTIAL', 'PAID', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ChallanStatus" AS ENUM ('DRAFT', 'DISPATCHED', 'DELIVERED', 'RETURNED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "GRNStatus" AS ENUM ('DRAFT', 'QC_PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CuttingStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PackingStatus" AS ENUM ('IN_PROGRESS', 'COMPLETED', 'DISPATCHED');

-- CreateEnum
CREATE TYPE "MachineStatus" AS ENUM ('OPERATIONAL', 'UNDER_MAINTENANCE', 'BREAKDOWN', 'RETIRED');

-- CreateEnum
CREATE TYPE "BreakdownStatus" AS ENUM ('OPEN', 'ASSIGNED', 'RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "MaintenanceStatus" AS ENUM ('PENDING', 'DONE', 'OVERDUE', 'SKIPPED');

-- CreateEnum
CREATE TYPE "WorkstationType" AS ENUM ('IN_HOUSE', 'JOB_WORK');

-- CreateEnum
CREATE TYPE "StockOwnership" AS ENUM ('OWNED', 'CUSTOMER_OWNED');

-- CreateEnum
CREATE TYPE "NoteStatus" AS ENUM ('DRAFT', 'ISSUED', 'ADJUSTED', 'CANCELLED');

-- AlterTable
ALTER TABLE "company" ADD COLUMN     "booksStartDate" TIMESTAMP(3),
ADD COLUMN     "msmeNumber" TEXT,
ADD COLUMN     "stateCode" TEXT,
ADD COLUMN     "tan" TEXT;

-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "billingStateCode" TEXT,
ADD COLUMN     "brokerId" TEXT,
ADD COLUMN     "brokeragePercent" DECIMAL(5,2),
ADD COLUMN     "isGroupCompany" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "shippingCity" TEXT,
ADD COLUMN     "shippingGstin" TEXT,
ADD COLUMN     "shippingPincode" TEXT,
ADD COLUMN     "shippingState" TEXT,
ADD COLUMN     "shippingStateCode" TEXT;

-- AlterTable
ALTER TABLE "cutting_orders" DROP COLUMN "status",
ADD COLUMN     "status" "CuttingStatus" NOT NULL DEFAULT 'PENDING';

-- AlterTable
ALTER TABLE "delivery_challan_lines" DROP COLUMN "uom",
ADD COLUMN     "uomId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "delivery_challans" DROP COLUMN "status",
ADD COLUMN     "status" "ChallanStatus" NOT NULL DEFAULT 'DRAFT';

-- AlterTable
ALTER TABLE "grn" DROP COLUMN "status",
ADD COLUMN     "status" "GRNStatus" NOT NULL DEFAULT 'DRAFT';

-- AlterTable
ALTER TABLE "items" ADD COLUMN     "taxRateId" TEXT;

-- AlterTable
ALTER TABLE "machine_breakdowns" DROP COLUMN "status",
ADD COLUMN     "status" "BreakdownStatus" NOT NULL DEFAULT 'OPEN';

-- AlterTable
ALTER TABLE "machines" DROP COLUMN "status",
ADD COLUMN     "status" "MachineStatus" NOT NULL DEFAULT 'OPERATIONAL';

-- AlterTable
ALTER TABLE "maintenance_schedules" DROP COLUMN "status",
ADD COLUMN     "status" "MaintenanceStatus" NOT NULL DEFAULT 'PENDING';

-- AlterTable
ALTER TABLE "material_requisitions" DROP COLUMN "department",
ADD COLUMN     "departmentId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "mo_lines" DROP COLUMN "sizeBreakup";

-- AlterTable
ALTER TABLE "operations" ADD COLUMN     "jobWorkRate" DECIMAL(10,2),
ADD COLUMN     "sortOrder" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "packing_orders" DROP COLUMN "status",
ADD COLUMN     "status" "PackingStatus" NOT NULL DEFAULT 'IN_PROGRESS';

-- AlterTable
ALTER TABLE "production_entries" DROP COLUMN "department",
DROP COLUMN "lineNumber",
ADD COLUMN     "departmentId" TEXT NOT NULL,
ADD COLUMN     "workstationId" TEXT;

-- AlterTable
ALTER TABLE "purchase_invoices" ADD COLUMN     "discountAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "isReverseCharge" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "roundOff" DECIMAL(6,2) NOT NULL DEFAULT 0,
ADD COLUMN     "taxableAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "tdsAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "tdsRate" DECIMAL(5,2),
ADD COLUMN     "tdsSection" TEXT,
DROP COLUMN "status",
ADD COLUMN     "status" "InvoiceStatus" NOT NULL DEFAULT 'UNPAID';

-- AlterTable
ALTER TABLE "sales_invoices" ADD COLUMN     "brokerId" TEXT,
ADD COLUMN     "brokerageAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "brokeragePercent" DECIMAL(5,2),
ADD COLUMN     "discountAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "placeOfSupplyCode" TEXT,
ADD COLUMN     "roundOff" DECIMAL(6,2) NOT NULL DEFAULT 0,
ADD COLUMN     "taxableAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
DROP COLUMN "status",
ADD COLUMN     "status" "InvoiceStatus" NOT NULL DEFAULT 'UNPAID';

-- AlterTable
ALTER TABLE "sales_order_lines" DROP COLUMN "sizeBreakup";

-- AlterTable
ALTER TABLE "sales_orders" ADD COLUMN     "brokerId" TEXT,
ADD COLUMN     "brokerageAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "brokeragePercent" DECIMAL(5,2),
ADD COLUMN     "placeOfSupplyCode" TEXT,
ADD COLUMN     "roundOff" DECIMAL(6,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "stock_ledger" ADD COLUMN     "ownerCustomerId" TEXT,
ADD COLUMN     "ownership" "StockOwnership" NOT NULL DEFAULT 'OWNED';

-- AlterTable
ALTER TABLE "styles" DROP COLUMN "sizeSet",
ADD COLUMN     "sizeGroupId" TEXT;

-- AlterTable
ALTER TABLE "suppliers" ADD COLUMN     "isGroupCompany" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "isMsme" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "msmeNumber" TEXT,
ADD COLUMN     "stateCode" TEXT;

-- CreateTable
CREATE TABLE "brokers" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "gstin" TEXT,
    "pan" TEXT,
    "address" TEXT,
    "city" TEXT,
    "state" TEXT,
    "stateCode" TEXT,
    "brokeragePercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "tdsSection" TEXT,
    "tdsRate" DECIMAL(5,2),
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "brokers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workstations" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,
    "type" "WorkstationType" NOT NULL DEFAULT 'IN_HOUSE',
    "supplierId" TEXT,
    "capacityPerDay" INTEGER,
    "address" TEXT,
    "contactPerson" TEXT,
    "phone" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workstations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "routings" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "styleId" TEXT NOT NULL,
    "isLocked" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "routings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "routing_steps" (
    "id" TEXT NOT NULL,
    "routingId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "operationId" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,
    "workstationId" TEXT,
    "smv" DECIMAL(5,3),
    "ratePerPiece" DECIMAL(10,2),
    "isQcStep" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "routing_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "size_groups" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "gender" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "size_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sizes" (
    "id" TEXT NOT NULL,
    "sizeGroupId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "sizes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_order_line_sizes" (
    "id" TEXT NOT NULL,
    "lineId" TEXT NOT NULL,
    "sizeId" TEXT NOT NULL,
    "qty" DECIMAL(10,2) NOT NULL,

    CONSTRAINT "sales_order_line_sizes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mo_line_sizes" (
    "id" TEXT NOT NULL,
    "moLineId" TEXT NOT NULL,
    "sizeId" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,

    CONSTRAINT "mo_line_sizes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_invoice_lines" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "description" TEXT,
    "hsnCode" TEXT,
    "qty" DECIMAL(10,3) NOT NULL,
    "unitPrice" DECIMAL(10,2) NOT NULL,
    "discount" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "taxableValue" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "gstRate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "cgst" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "sgst" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "igst" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "sales_invoice_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_invoice_lines" (
    "id" TEXT NOT NULL,
    "billId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "description" TEXT,
    "hsnCode" TEXT,
    "qty" DECIMAL(10,3) NOT NULL,
    "unitPrice" DECIMAL(10,2) NOT NULL,
    "discount" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "taxableValue" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "gstRate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "cgst" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "sgst" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "igst" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "purchase_invoice_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "charge_types" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "defaultGstRate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "applyOnSale" BOOLEAN NOT NULL DEFAULT true,
    "applyOnPurchase" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "charge_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_invoice_charges" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "chargeTypeId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "gstRate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "cgst" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "sgst" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "igst" DECIMAL(12,2) NOT NULL DEFAULT 0,

    CONSTRAINT "sales_invoice_charges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_invoice_charges" (
    "id" TEXT NOT NULL,
    "billId" TEXT NOT NULL,
    "chargeTypeId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "gstRate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "cgst" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "sgst" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "igst" DECIMAL(12,2) NOT NULL DEFAULT 0,

    CONSTRAINT "purchase_invoice_charges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_notes" (
    "id" TEXT NOT NULL,
    "noteNumber" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "invoiceId" TEXT,
    "noteDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT,
    "subtotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "cgst" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "sgst" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "igst" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "roundOff" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "totalAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "status" "NoteStatus" NOT NULL DEFAULT 'DRAFT',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "credit_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_note_lines" (
    "id" TEXT NOT NULL,
    "noteId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "description" TEXT,
    "hsnCode" TEXT,
    "qty" DECIMAL(10,3) NOT NULL,
    "unitPrice" DECIMAL(10,2) NOT NULL,
    "taxableValue" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "gstRate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "credit_note_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "debit_notes" (
    "id" TEXT NOT NULL,
    "noteNumber" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "billId" TEXT,
    "noteDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT,
    "subtotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "cgst" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "sgst" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "igst" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "roundOff" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "totalAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "status" "NoteStatus" NOT NULL DEFAULT 'DRAFT',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "debit_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "debit_note_lines" (
    "id" TEXT NOT NULL,
    "noteId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "description" TEXT,
    "hsnCode" TEXT,
    "qty" DECIMAL(10,3) NOT NULL,
    "unitPrice" DECIMAL(10,2) NOT NULL,
    "taxableValue" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "gstRate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "debit_note_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "brokers_code_key" ON "brokers"("code");

-- CreateIndex
CREATE INDEX "brokers_code_idx" ON "brokers"("code");

-- CreateIndex
CREATE UNIQUE INDEX "workstations_code_key" ON "workstations"("code");

-- CreateIndex
CREATE INDEX "workstations_code_idx" ON "workstations"("code");

-- CreateIndex
CREATE UNIQUE INDEX "routings_code_key" ON "routings"("code");

-- CreateIndex
CREATE INDEX "routings_styleId_idx" ON "routings"("styleId");

-- CreateIndex
CREATE UNIQUE INDEX "routing_steps_routingId_sequence_key" ON "routing_steps"("routingId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "size_groups_name_key" ON "size_groups"("name");

-- CreateIndex
CREATE UNIQUE INDEX "sizes_sizeGroupId_code_key" ON "sizes"("sizeGroupId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "sales_order_line_sizes_lineId_sizeId_key" ON "sales_order_line_sizes"("lineId", "sizeId");

-- CreateIndex
CREATE UNIQUE INDEX "mo_line_sizes_moLineId_sizeId_key" ON "mo_line_sizes"("moLineId", "sizeId");

-- CreateIndex
CREATE INDEX "sales_invoice_lines_invoiceId_idx" ON "sales_invoice_lines"("invoiceId");

-- CreateIndex
CREATE INDEX "purchase_invoice_lines_billId_idx" ON "purchase_invoice_lines"("billId");

-- CreateIndex
CREATE UNIQUE INDEX "charge_types_name_key" ON "charge_types"("name");

-- CreateIndex
CREATE UNIQUE INDEX "credit_notes_noteNumber_key" ON "credit_notes"("noteNumber");

-- CreateIndex
CREATE INDEX "credit_notes_customerId_idx" ON "credit_notes"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "debit_notes_noteNumber_key" ON "debit_notes"("noteNumber");

-- CreateIndex
CREATE INDEX "debit_notes_supplierId_idx" ON "debit_notes"("supplierId");

-- CreateIndex
CREATE INDEX "stock_ledger_ownership_ownerCustomerId_idx" ON "stock_ledger"("ownership", "ownerCustomerId");

-- AddForeignKey
ALTER TABLE "items" ADD CONSTRAINT "items_taxRateId_fkey" FOREIGN KEY ("taxRateId") REFERENCES "tax_rates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "styles" ADD CONSTRAINT "styles_sizeGroupId_fkey" FOREIGN KEY ("sizeGroupId") REFERENCES "size_groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_brokerId_fkey" FOREIGN KEY ("brokerId") REFERENCES "brokers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_brokerId_fkey" FOREIGN KEY ("brokerId") REFERENCES "brokers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_invoices" ADD CONSTRAINT "sales_invoices_brokerId_fkey" FOREIGN KEY ("brokerId") REFERENCES "brokers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_challan_lines" ADD CONSTRAINT "delivery_challan_lines_uomId_fkey" FOREIGN KEY ("uomId") REFERENCES "uom"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_ledger" ADD CONSTRAINT "stock_ledger_ownerCustomerId_fkey" FOREIGN KEY ("ownerCustomerId") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_requisitions" ADD CONSTRAINT "material_requisitions_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_entries" ADD CONSTRAINT "production_entries_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_entries" ADD CONSTRAINT "production_entries_workstationId_fkey" FOREIGN KEY ("workstationId") REFERENCES "workstations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_entries" ADD CONSTRAINT "production_entries_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "operations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workstations" ADD CONSTRAINT "workstations_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workstations" ADD CONSTRAINT "workstations_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "routings" ADD CONSTRAINT "routings_styleId_fkey" FOREIGN KEY ("styleId") REFERENCES "styles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "routing_steps" ADD CONSTRAINT "routing_steps_routingId_fkey" FOREIGN KEY ("routingId") REFERENCES "routings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "routing_steps" ADD CONSTRAINT "routing_steps_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "operations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "routing_steps" ADD CONSTRAINT "routing_steps_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "routing_steps" ADD CONSTRAINT "routing_steps_workstationId_fkey" FOREIGN KEY ("workstationId") REFERENCES "workstations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sizes" ADD CONSTRAINT "sizes_sizeGroupId_fkey" FOREIGN KEY ("sizeGroupId") REFERENCES "size_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order_line_sizes" ADD CONSTRAINT "sales_order_line_sizes_lineId_fkey" FOREIGN KEY ("lineId") REFERENCES "sales_order_lines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order_line_sizes" ADD CONSTRAINT "sales_order_line_sizes_sizeId_fkey" FOREIGN KEY ("sizeId") REFERENCES "sizes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mo_line_sizes" ADD CONSTRAINT "mo_line_sizes_moLineId_fkey" FOREIGN KEY ("moLineId") REFERENCES "mo_lines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mo_line_sizes" ADD CONSTRAINT "mo_line_sizes_sizeId_fkey" FOREIGN KEY ("sizeId") REFERENCES "sizes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_invoice_lines" ADD CONSTRAINT "sales_invoice_lines_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "sales_invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_invoice_lines" ADD CONSTRAINT "sales_invoice_lines_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_invoice_lines" ADD CONSTRAINT "purchase_invoice_lines_billId_fkey" FOREIGN KEY ("billId") REFERENCES "purchase_invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_invoice_lines" ADD CONSTRAINT "purchase_invoice_lines_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_invoice_charges" ADD CONSTRAINT "sales_invoice_charges_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "sales_invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_invoice_charges" ADD CONSTRAINT "sales_invoice_charges_chargeTypeId_fkey" FOREIGN KEY ("chargeTypeId") REFERENCES "charge_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_invoice_charges" ADD CONSTRAINT "purchase_invoice_charges_billId_fkey" FOREIGN KEY ("billId") REFERENCES "purchase_invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_invoice_charges" ADD CONSTRAINT "purchase_invoice_charges_chargeTypeId_fkey" FOREIGN KEY ("chargeTypeId") REFERENCES "charge_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "sales_invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_note_lines" ADD CONSTRAINT "credit_note_lines_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "credit_notes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_note_lines" ADD CONSTRAINT "credit_note_lines_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debit_notes" ADD CONSTRAINT "debit_notes_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debit_notes" ADD CONSTRAINT "debit_notes_billId_fkey" FOREIGN KEY ("billId") REFERENCES "purchase_invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debit_note_lines" ADD CONSTRAINT "debit_note_lines_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "debit_notes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debit_note_lines" ADD CONSTRAINT "debit_note_lines_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
