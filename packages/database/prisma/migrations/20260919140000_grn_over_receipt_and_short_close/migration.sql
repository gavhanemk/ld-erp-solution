-- Two CA-lens edge cases for goods receipt against a purchase order:
--
-- 1. A supplier who delivers a bit more than ordered (roll/bale variance) can
--    now be booked in within a configured tolerance without any extra step,
--    and past it with a reason recorded on the receipt itself.
-- 2. A line whose balance is never coming can be closed short instead of
--    leaving the order "Partially Received" forever.
--
-- Hand-written, and additive only — see MIGRATION-NOTES.md for why
-- `prisma migrate dev` is not used on this branch.

ALTER TABLE "grn"
  ADD COLUMN IF NOT EXISTS "overReceiptReason" TEXT;

ALTER TABLE "purchase_order_lines"
  ADD COLUMN IF NOT EXISTS "shortClosed" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "shortCloseReason" TEXT,
  ADD COLUMN IF NOT EXISTS "shortClosedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "shortClosedById" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'purchase_order_lines_shortClosedById_fkey'
  ) THEN
    ALTER TABLE "purchase_order_lines"
      ADD CONSTRAINT "purchase_order_lines_shortClosedById_fkey"
      FOREIGN KEY ("shortClosedById") REFERENCES "users"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END
$$;
