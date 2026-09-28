-- Two things, both about a record not being allowed to outlive what it
-- describes.
--
-- 1. Three foreign keys move from ON DELETE SET NULL to ON DELETE RESTRICT.
--    Every one of them had a guard in the API that could never fire: the
--    delete route for a goods receipt catches Postgres error P2003 and says
--    "that receipt has a bill matched against it", and P2003 was impossible
--    because the database would quietly null the bill line instead. The
--    receipt went, its stock came back out, and the bill kept a line pointing
--    at nothing — never three-way matched again, with nothing on it to say so.
--
-- 2. A supplier payment gains a status, so a bounced cheque can be reversed
--    rather than deleted.
--
-- Hand-written, and non-destructive — see MIGRATION-NOTES.md for why
-- `prisma migrate dev` is not used on this branch.
--
-- Changing a referential action is a DROP and re-ADD of the constraint. No row
-- is read or written by it; the re-ADD validates that existing values still
-- point at rows that exist, which was checked first and found clean:
--   purchase_invoice_lines with grnLineId NULL: 0 of 2
--   grn_lines             with poLineId   NULL: 0 of 2

-- ── 1. A bill line must not outlive the receipt line it settles ────────────
ALTER TABLE "purchase_invoice_lines"
  DROP CONSTRAINT IF EXISTS "purchase_invoice_lines_grnLineId_fkey";
ALTER TABLE "purchase_invoice_lines"
  ADD CONSTRAINT "purchase_invoice_lines_grnLineId_fkey"
  FOREIGN KEY ("grnLineId") REFERENCES "grn_lines"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── 2. A receipt line must not outlive the order line it was booked against ─
ALTER TABLE "grn_lines"
  DROP CONSTRAINT IF EXISTS "grn_lines_poLineId_fkey";
ALTER TABLE "grn_lines"
  ADD CONSTRAINT "grn_lines_poLineId_fkey"
  FOREIGN KEY ("poLineId") REFERENCES "purchase_order_lines"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── 3. A payment must not forget which bill it settled ────────────────────
ALTER TABLE "supplier_payments"
  DROP CONSTRAINT IF EXISTS "supplier_payments_invoiceId_fkey";
ALTER TABLE "supplier_payments"
  ADD CONSTRAINT "supplier_payments_invoiceId_fkey"
  FOREIGN KEY ("invoiceId") REFERENCES "purchase_invoices"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── 4. Reversing a payment instead of deleting it ─────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PaymentStatus') THEN
    CREATE TYPE "PaymentStatus" AS ENUM ('POSTED', 'REVERSED');
  END IF;
END
$$;

ALTER TABLE "supplier_payments"
  ADD COLUMN IF NOT EXISTS "status" "PaymentStatus" NOT NULL DEFAULT 'POSTED',
  ADD COLUMN IF NOT EXISTS "reversedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "reversedById" TEXT,
  ADD COLUMN IF NOT EXISTS "reversalReason" TEXT;

-- Who reversed it stays, even if they leave the mill: RESTRICT, not cascade.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'supplier_payments_reversedById_fkey'
  ) THEN
    ALTER TABLE "supplier_payments"
      ADD CONSTRAINT "supplier_payments_reversedById_fkey"
      FOREIGN KEY ("reversedById") REFERENCES "users"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END
$$;

-- A reversed payment has to say who reversed it and why. Nothing is reversed
-- yet, so this validates against an empty set and cannot fail on real data.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'supplier_payments_reversal_is_explained'
  ) THEN
    ALTER TABLE "supplier_payments"
      ADD CONSTRAINT "supplier_payments_reversal_is_explained"
      CHECK (
        "status" <> 'REVERSED'
        OR ("reversedAt" IS NOT NULL AND "reversedById" IS NOT NULL AND "reversalReason" IS NOT NULL)
      );
  END IF;
END
$$;
