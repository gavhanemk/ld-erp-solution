-- Phase 7, final controls and audit (multi-brand plan).
--
-- Every change to a voucher keeps the voucher as it stood before, as a
-- numbered revision. Closing the books, reopening them and moving the day they
-- start are recorded with who, when and why. A reversing entry points at the
-- voucher it undoes. Nothing here is ever deleted, and the trail is never
-- rewritten: the database refuses both, whatever wrote the request.
-- Only adds: no table, column or row is removed.

CREATE TYPE "VoucherRevisionAction" AS ENUM ('ALTERED', 'REWRITTEN', 'BILLS_CHANGED', 'CANCELLED', 'REINSTATED', 'REMOVED', 'BANK_DATES', 'REVERSED');
CREATE TYPE "PeriodEventKind" AS ENUM ('CLOSED', 'REOPENED', 'START_SET');

-- The voucher: its last revision's number, and the voucher a reversing entry undoes.
ALTER TABLE "acc_vouchers" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "acc_vouchers" ADD COLUMN "reversalOfId" TEXT;
CREATE INDEX "acc_vouchers_reversalOfId_idx" ON "acc_vouchers"("reversalOfId");
ALTER TABLE "acc_vouchers" ADD CONSTRAINT "acc_vouchers_reversalOfId_fkey" FOREIGN KEY ("reversalOfId") REFERENCES "acc_vouchers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The books' dates: closed, reopened, start moved.
CREATE TABLE "acc_period_events" (
    "id" TEXT NOT NULL,
    "kind" "PeriodEventKind" NOT NULL,
    "fromDate" TIMESTAMP(3),
    "toDate" TIMESTAMP(3),
    "reason" TEXT,
    "userId" TEXT,
    "userName" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "acc_period_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "acc_period_events_at_idx" ON "acc_period_events"("at");
ALTER TABLE "acc_period_events" ADD CONSTRAINT "acc_period_events_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A voucher's revisions.
CREATE TABLE "acc_voucher_revisions" (
    "id" TEXT NOT NULL,
    "voucherId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "action" "VoucherRevisionAction" NOT NULL,
    "snapshot" JSONB NOT NULL,
    "reason" TEXT,
    "source" TEXT NOT NULL,
    "changedById" TEXT,
    "changedByName" TEXT,
    "periodEventId" TEXT,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "acc_voucher_revisions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "acc_voucher_revisions_voucherId_revision_key" ON "acc_voucher_revisions"("voucherId", "revision");
CREATE INDEX "acc_voucher_revisions_changedAt_idx" ON "acc_voucher_revisions"("changedAt");
ALTER TABLE "acc_voucher_revisions" ADD CONSTRAINT "acc_voucher_revisions_voucherId_fkey" FOREIGN KEY ("voucherId") REFERENCES "acc_vouchers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "acc_voucher_revisions" ADD CONSTRAINT "acc_voucher_revisions_changedById_fkey" FOREIGN KEY ("changedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "acc_voucher_revisions" ADD CONSTRAINT "acc_voucher_revisions_periodEventId_fkey" FOREIGN KEY ("periodEventId") REFERENCES "acc_period_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- An allocation run's source voucher can no longer vanish from under it.
-- (Checked before this was written: no source row points at a missing voucher.)
ALTER TABLE "acc_allocation_run_sources" ADD CONSTRAINT "acc_allocation_run_sources_voucherId_fkey" FOREIGN KEY ("voucherId") REFERENCES "acc_vouchers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Nothing in the books is deleted. Only a session that says so outright
-- (SET LOCAL "ld_erp.allow_books_delete" = 'on', as the test tools do inside a
-- transaction they roll back) may; the application never does.
-- The function keeps the schema it was made in, whoever's session fires it.
CREATE OR REPLACE FUNCTION "acc_refuse_delete"() RETURNS trigger
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $$
BEGIN
  IF COALESCE(current_setting('ld_erp.allow_books_delete', true), '') <> 'on' THEN
    RAISE EXCEPTION 'BOOKS_NO_DELETE: % rows are never deleted; cancel the voucher or reverse it instead', TG_TABLE_NAME
      USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END
$$;

-- …and the trail of changes is never rewritten.
CREATE OR REPLACE FUNCTION "acc_refuse_update"() RETURNS trigger
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $$
BEGIN
  RAISE EXCEPTION 'BOOKS_TRAIL_FIXED: % rows are never changed once written', TG_TABLE_NAME
    USING ERRCODE = '23514';
END
$$;

CREATE TRIGGER "acc_vouchers_no_delete" BEFORE DELETE ON "acc_vouchers" FOR EACH ROW EXECUTE FUNCTION "acc_refuse_delete"();
CREATE TRIGGER "acc_voucher_revisions_no_delete" BEFORE DELETE ON "acc_voucher_revisions" FOR EACH ROW EXECUTE FUNCTION "acc_refuse_delete"();
CREATE TRIGGER "acc_period_events_no_delete" BEFORE DELETE ON "acc_period_events" FOR EACH ROW EXECUTE FUNCTION "acc_refuse_delete"();
CREATE TRIGGER "acc_voucher_revisions_no_update" BEFORE UPDATE ON "acc_voucher_revisions" FOR EACH ROW EXECUTE FUNCTION "acc_refuse_update"();
CREATE TRIGGER "acc_period_events_no_update" BEFORE UPDATE ON "acc_period_events" FOR EACH ROW EXECUTE FUNCTION "acc_refuse_update"();
