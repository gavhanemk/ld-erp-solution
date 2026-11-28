-- Accounting dimensions: the department (cost centre) beside the brand
-- (profit centre) on income and expense lines. One set of books: these are
-- tags on its lines, not a second ledger. Nothing existing changes until
-- documents are posted again.

-- The department an accounts line belongs to.
ALTER TABLE "acc_voucher_lines" ADD COLUMN "departmentId" TEXT;
ALTER TABLE "acc_voucher_lines"
  ADD CONSTRAINT "acc_voucher_lines_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "acc_voucher_lines_departmentId_idx" ON "acc_voucher_lines"("departmentId");

-- An income or expense ledger's usual brand and department.
ALTER TABLE "ledgers" ADD COLUMN "costCentreId" TEXT, ADD COLUMN "departmentId" TEXT;
ALTER TABLE "ledgers"
  ADD CONSTRAINT "ledgers_costCentreId_fkey" FOREIGN KEY ("costCentreId") REFERENCES "cost_centres"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "ledgers_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Brand and department picked on a bill line (an expense, mostly).
ALTER TABLE "purchase_invoice_lines" ADD COLUMN "costCentreId" TEXT, ADD COLUMN "departmentId" TEXT;
ALTER TABLE "purchase_invoice_lines"
  ADD CONSTRAINT "purchase_invoice_lines_costCentreId_fkey" FOREIGN KEY ("costCentreId") REFERENCES "cost_centres"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "purchase_invoice_lines_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
