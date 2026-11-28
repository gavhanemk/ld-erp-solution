-- Who wrote each stock movement. Empty for rows written before this, and for
-- scripts and seeds, which have no signed-in user.
ALTER TABLE "stock_ledger" ADD COLUMN "createdById" TEXT;
ALTER TABLE "stock_ledger" ADD CONSTRAINT "stock_ledger_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A voucher's debits must equal its credits. The application already checks
-- this before it writes; the database now refuses an unbalanced voucher too,
-- whatever wrote it. The check runs when the transaction commits, after every
-- line of the voucher is in, so writing lines one by one is fine.
-- The function keeps the schema it was made in, whoever's session fires it.
CREATE OR REPLACE FUNCTION "acc_voucher_must_balance"() RETURNS trigger
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $$
DECLARE
  v_id TEXT;
  total_debit NUMERIC;
  total_credit NUMERIC;
  v_no TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_id := OLD."voucherId";
  ELSE
    v_id := NEW."voucherId";
  END IF;
  SELECT COALESCE(SUM("debit"), 0), COALESCE(SUM("credit"), 0)
    INTO total_debit, total_credit
    FROM "acc_voucher_lines" WHERE "voucherId" = v_id;
  IF total_debit <> total_credit THEN
    SELECT "voucherNo" INTO v_no FROM "acc_vouchers" WHERE "id" = v_id;
    RAISE EXCEPTION 'VOUCHER_NOT_BALANCED: voucher % debits % but credits %', COALESCE(v_no, v_id), total_debit, total_credit
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER "acc_voucher_lines_balance"
  AFTER INSERT OR UPDATE OR DELETE ON "acc_voucher_lines"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "acc_voucher_must_balance"();
