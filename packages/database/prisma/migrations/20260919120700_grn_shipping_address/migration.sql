-- The mill's own receiving address on a goods receipt — the old system's
-- "Shipping Address", separate from the supplier's own billing address.
--
-- Hand-written, and additive only — see MIGRATION-NOTES.md for why
-- `prisma migrate dev` is not used on this branch.

ALTER TABLE "grn"
  ADD COLUMN IF NOT EXISTS "shippingAddress" TEXT;
