-- The books: groups, ledgers, cost centres, vouchers, their lines and the bills
-- they raise or settle. Adds only; the old unused accounts / vouchers /
-- voucher_lines tables are left as they are (models renamed Legacy* in code).

-- CreateEnum
CREATE TYPE "LedgerNature" AS ENUM ('ASSET', 'LIABILITY', 'INCOME', 'EXPENSE');

-- CreateEnum
CREATE TYPE "LedgerParty" AS ENUM ('CUSTOMER', 'SUPPLIER', 'BROKER', 'CONTRACTOR', 'BANK');

-- CreateEnum
CREATE TYPE "VoucherKind" AS ENUM ('PAYMENT', 'RECEIPT', 'CONTRA', 'JOURNAL', 'SALES', 'PURCHASE', 'CREDIT_NOTE', 'DEBIT_NOTE');

-- CreateEnum
CREATE TYPE "VoucherState" AS ENUM ('POSTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "BillRefKind" AS ENUM ('NEW_REF', 'AGAINST_REF', 'ADVANCE', 'ON_ACCOUNT');

-- AlterTable
ALTER TABLE "company" ADD COLUMN     "booksLockedUpTo" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ledger_groups" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parentId" TEXT,
    "nature" "LedgerNature" NOT NULL,
    "affectsGrossProfit" BOOLEAN NOT NULL DEFAULT false,
    "systemKey" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ledger_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledgers" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "openingBalance" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "billWise" BOOLEAN NOT NULL DEFAULT false,
    "systemKey" TEXT,
    "partyType" "LedgerParty",
    "customerId" TEXT,
    "supplierId" TEXT,
    "brokerId" TEXT,
    "contractorId" TEXT,
    "bankAccountId" TEXT,
    "pan" TEXT,
    "gstin" TEXT,
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ledgers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cost_centres" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "brandId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cost_centres_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "acc_vouchers" (
    "id" TEXT NOT NULL,
    "kind" "VoucherKind" NOT NULL,
    "voucherNo" TEXT NOT NULL,
    "financialYear" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "narration" TEXT,
    "amount" DECIMAL(14,2) NOT NULL,
    "mode" "PaymentMode",
    "referenceNo" TEXT,
    "chequeNo" TEXT,
    "chequeDate" TIMESTAMP(3),
    "sourceType" TEXT,
    "sourceId" TEXT,
    "status" "VoucherState" NOT NULL DEFAULT 'POSTED',
    "cancelledAt" TIMESTAMP(3),
    "cancelledById" TEXT,
    "cancelReason" TEXT,
    "createdById" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "acc_vouchers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "acc_voucher_lines" (
    "id" TEXT NOT NULL,
    "voucherId" TEXT NOT NULL,
    "ledgerId" TEXT NOT NULL,
    "debit" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "credit" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "costCentreId" TEXT,
    "narration" TEXT,
    "bankDate" TIMESTAMP(3),
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "acc_voucher_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "acc_bill_refs" (
    "id" TEXT NOT NULL,
    "lineId" TEXT,
    "ledgerId" TEXT NOT NULL,
    "kind" "BillRefKind" NOT NULL,
    "billNo" TEXT NOT NULL,
    "billDate" TIMESTAMP(3) NOT NULL,
    "dueDate" TIMESTAMP(3),
    "amount" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "acc_bill_refs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ledger_groups_name_key" ON "ledger_groups"("name");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_groups_systemKey_key" ON "ledger_groups"("systemKey");

-- CreateIndex
CREATE INDEX "ledger_groups_parentId_idx" ON "ledger_groups"("parentId");

-- CreateIndex
CREATE UNIQUE INDEX "ledgers_name_key" ON "ledgers"("name");

-- CreateIndex
CREATE UNIQUE INDEX "ledgers_systemKey_key" ON "ledgers"("systemKey");

-- CreateIndex
CREATE UNIQUE INDEX "ledgers_customerId_key" ON "ledgers"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "ledgers_supplierId_key" ON "ledgers"("supplierId");

-- CreateIndex
CREATE UNIQUE INDEX "ledgers_brokerId_key" ON "ledgers"("brokerId");

-- CreateIndex
CREATE UNIQUE INDEX "ledgers_contractorId_key" ON "ledgers"("contractorId");

-- CreateIndex
CREATE UNIQUE INDEX "ledgers_bankAccountId_key" ON "ledgers"("bankAccountId");

-- CreateIndex
CREATE INDEX "ledgers_groupId_idx" ON "ledgers"("groupId");

-- CreateIndex
CREATE UNIQUE INDEX "cost_centres_name_key" ON "cost_centres"("name");

-- CreateIndex
CREATE UNIQUE INDEX "cost_centres_brandId_key" ON "cost_centres"("brandId");

-- CreateIndex
CREATE INDEX "acc_vouchers_date_idx" ON "acc_vouchers"("date");

-- CreateIndex
CREATE INDEX "acc_vouchers_financialYear_kind_idx" ON "acc_vouchers"("financialYear", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "acc_vouchers_kind_voucherNo_key" ON "acc_vouchers"("kind", "voucherNo");

-- CreateIndex
CREATE UNIQUE INDEX "acc_vouchers_sourceType_sourceId_key" ON "acc_vouchers"("sourceType", "sourceId");

-- CreateIndex
CREATE INDEX "acc_voucher_lines_ledgerId_idx" ON "acc_voucher_lines"("ledgerId");

-- CreateIndex
CREATE INDEX "acc_voucher_lines_voucherId_idx" ON "acc_voucher_lines"("voucherId");

-- CreateIndex
CREATE INDEX "acc_bill_refs_ledgerId_billNo_idx" ON "acc_bill_refs"("ledgerId", "billNo");

-- CreateIndex
CREATE INDEX "acc_bill_refs_lineId_idx" ON "acc_bill_refs"("lineId");

-- AddForeignKey
ALTER TABLE "ledger_groups" ADD CONSTRAINT "ledger_groups_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "ledger_groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledgers" ADD CONSTRAINT "ledgers_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "ledger_groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledgers" ADD CONSTRAINT "ledgers_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledgers" ADD CONSTRAINT "ledgers_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledgers" ADD CONSTRAINT "ledgers_brokerId_fkey" FOREIGN KEY ("brokerId") REFERENCES "brokers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledgers" ADD CONSTRAINT "ledgers_contractorId_fkey" FOREIGN KEY ("contractorId") REFERENCES "contractors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledgers" ADD CONSTRAINT "ledgers_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "bank_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledgers" ADD CONSTRAINT "ledgers_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_centres" ADD CONSTRAINT "cost_centres_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "brands"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "acc_vouchers" ADD CONSTRAINT "acc_vouchers_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "acc_vouchers" ADD CONSTRAINT "acc_vouchers_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "acc_vouchers" ADD CONSTRAINT "acc_vouchers_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "acc_voucher_lines" ADD CONSTRAINT "acc_voucher_lines_voucherId_fkey" FOREIGN KEY ("voucherId") REFERENCES "acc_vouchers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "acc_voucher_lines" ADD CONSTRAINT "acc_voucher_lines_ledgerId_fkey" FOREIGN KEY ("ledgerId") REFERENCES "ledgers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "acc_voucher_lines" ADD CONSTRAINT "acc_voucher_lines_costCentreId_fkey" FOREIGN KEY ("costCentreId") REFERENCES "cost_centres"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "acc_bill_refs" ADD CONSTRAINT "acc_bill_refs_lineId_fkey" FOREIGN KEY ("lineId") REFERENCES "acc_voucher_lines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "acc_bill_refs" ADD CONSTRAINT "acc_bill_refs_ledgerId_fkey" FOREIGN KEY ("ledgerId") REFERENCES "ledgers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- A line is a debit or a credit, never both and never neither; nothing is negative.
ALTER TABLE "acc_voucher_lines" ADD CONSTRAINT "acc_voucher_lines_one_side" CHECK (("debit" > 0 AND "credit" = 0) OR ("credit" > 0 AND "debit" = 0));
ALTER TABLE "acc_vouchers" ADD CONSTRAINT "acc_vouchers_amount_positive" CHECK ("amount" > 0);
