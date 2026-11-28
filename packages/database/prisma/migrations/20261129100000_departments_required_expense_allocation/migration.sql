-- Departments required on new expenses, with a marked way in for legacy
-- imports; and the monthly split of shared expenses between the brands.

-- Brought in from the old books without the department now required.
ALTER TABLE "acc_vouchers" ADD COLUMN "legacyImport" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "purchase_invoices" ADD COLUMN "legacyImport" BOOLEAN NOT NULL DEFAULT false;

CREATE TYPE "AllocationBasis" AS ENUM ('REVENUE', 'PRODUCTION_QTY', 'MATERIAL_CONSUMPTION', 'MACHINE_HOURS', 'FIXED_PERCENT', 'MANUAL');
CREATE TYPE "AllocationRunStatus" AS ENUM ('DRAFT', 'APPROVED', 'POSTED', 'REVERSED', 'DISCARDED');

CREATE TABLE "acc_allocation_rules" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "basis" "AllocationBasis" NOT NULL,
  "ledgerIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "departmentIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "costCentreIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "notes" TEXT,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "acc_allocation_rules_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "acc_allocation_rules_name_key" ON "acc_allocation_rules"("name");
ALTER TABLE "acc_allocation_rules"
  ADD CONSTRAINT "acc_allocation_rules_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "acc_allocation_rule_shares" (
  "id" TEXT NOT NULL,
  "ruleId" TEXT NOT NULL,
  "costCentreId" TEXT NOT NULL,
  "percent" DECIMAL(9,4) NOT NULL,
  CONSTRAINT "acc_allocation_rule_shares_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "acc_allocation_rule_shares_ruleId_costCentreId_key" ON "acc_allocation_rule_shares"("ruleId", "costCentreId");
ALTER TABLE "acc_allocation_rule_shares"
  ADD CONSTRAINT "acc_allocation_rule_shares_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "acc_allocation_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "acc_allocation_rule_shares_costCentreId_fkey" FOREIGN KEY ("costCentreId") REFERENCES "cost_centres"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "acc_allocation_runs" (
  "id" TEXT NOT NULL,
  "runNumber" TEXT NOT NULL,
  "period" TEXT NOT NULL,
  "status" "AllocationRunStatus" NOT NULL DEFAULT 'DRAFT',
  "inputs" JSONB,
  "notes" TEXT,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "approvedById" TEXT,
  "approvedAt" TIMESTAMP(3),
  "postedById" TEXT,
  "postedAt" TIMESTAMP(3),
  "reversedById" TEXT,
  "reversedAt" TIMESTAMP(3),
  "reverseReason" TEXT,
  "discardedAt" TIMESTAMP(3),
  "discardReason" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "acc_allocation_runs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "acc_allocation_runs_runNumber_key" ON "acc_allocation_runs"("runNumber");
CREATE INDEX "acc_allocation_runs_period_idx" ON "acc_allocation_runs"("period");
-- One live run a month: a second is refused until the first is reversed or discarded.
CREATE UNIQUE INDEX "acc_allocation_runs_one_live" ON "acc_allocation_runs"("period") WHERE "status" IN ('DRAFT', 'APPROVED', 'POSTED');
ALTER TABLE "acc_allocation_runs"
  ADD CONSTRAINT "acc_allocation_runs_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "acc_allocation_runs_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "acc_allocation_runs_postedById_fkey" FOREIGN KEY ("postedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "acc_allocation_runs_reversedById_fkey" FOREIGN KEY ("reversedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "acc_allocation_run_lines" (
  "id" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "ruleId" TEXT NOT NULL,
  "ledgerId" TEXT NOT NULL,
  "departmentId" TEXT,
  "costCentreId" TEXT NOT NULL,
  "sharedAmount" DECIMAL(14,2) NOT NULL,
  "basisValue" DECIMAL(16,4) NOT NULL,
  "percent" DECIMAL(9,6) NOT NULL,
  "amount" DECIMAL(14,2) NOT NULL,
  CONSTRAINT "acc_allocation_run_lines_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "acc_allocation_run_lines_runId_idx" ON "acc_allocation_run_lines"("runId");
ALTER TABLE "acc_allocation_run_lines"
  ADD CONSTRAINT "acc_allocation_run_lines_runId_fkey" FOREIGN KEY ("runId") REFERENCES "acc_allocation_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "acc_allocation_run_lines_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "acc_allocation_rules"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "acc_allocation_run_lines_ledgerId_fkey" FOREIGN KEY ("ledgerId") REFERENCES "ledgers"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "acc_allocation_run_lines_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "acc_allocation_run_lines_costCentreId_fkey" FOREIGN KEY ("costCentreId") REFERENCES "cost_centres"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "acc_allocation_run_sources" (
  "id" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "voucherId" TEXT NOT NULL,
  "ledgerId" TEXT NOT NULL,
  "departmentId" TEXT,
  "amount" DECIMAL(14,2) NOT NULL,
  CONSTRAINT "acc_allocation_run_sources_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "acc_allocation_run_sources_runId_idx" ON "acc_allocation_run_sources"("runId");
ALTER TABLE "acc_allocation_run_sources"
  ADD CONSTRAINT "acc_allocation_run_sources_runId_fkey" FOREIGN KEY ("runId") REFERENCES "acc_allocation_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
