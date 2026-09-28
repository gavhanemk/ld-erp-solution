-- The fields the mill's own payment voucher carries, which ours did not:
--
--   * where the payment is booked ("Location"), and the account the money left
--     ("Paid Through") — neither of which had anywhere to go, so a payment
--     could not be reconciled against a bank statement;
--   * the cheque number, which was being written into `referenceNo` even
--     though `chequeDate` already sat there on its own;
--   * tax withheld at payment time, for the case where the bill did not
--     already record it;
--   * files — the bank advice, the counterfoil, the UTR screenshot.
--
-- Hand-written, and additive only — see MIGRATION-NOTES.md for why
-- `prisma migrate dev` is not used on this branch. Its generated diff for this
-- change still wants to drop `bom_line_sizes`, eight BOM columns and
-- `items.styleId`, which are the other team's applied work. The answer is no.

ALTER TABLE "supplier_payments"
  ADD COLUMN IF NOT EXISTS "warehouseId" TEXT,
  ADD COLUMN IF NOT EXISTS "bankAccountId" TEXT,
  ADD COLUMN IF NOT EXISTS "chequeNo" TEXT,
  ADD COLUMN IF NOT EXISTS "tdsAmount" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- RESTRICT rather than SET NULL on both. A payment that has forgotten which
-- account it came out of cannot be tied to a bank statement, and that is the
-- one thing a payment record exists to support. Retiring a bank account or a
-- store is what their `isActive` flags are for.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'supplier_payments_warehouseId_fkey'
  ) THEN
    ALTER TABLE "supplier_payments"
      ADD CONSTRAINT "supplier_payments_warehouseId_fkey"
      FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'supplier_payments_bankAccountId_fkey'
  ) THEN
    ALTER TABLE "supplier_payments"
      ADD CONSTRAINT "supplier_payments_bankAccountId_fkey"
      FOREIGN KEY ("bankAccountId") REFERENCES "bank_accounts"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END
$$;

-- The file itself stays in the bucket; the row only records where. Same shape
-- as `purchase_order_attachments` and `grn_attachments`.
CREATE TABLE IF NOT EXISTS "supplier_payment_attachments" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "mimeType" TEXT,
    "sizeBytes" INTEGER NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_payment_attachments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "supplier_payment_attachments_storagePath_key"
  ON "supplier_payment_attachments"("storagePath");

CREATE INDEX IF NOT EXISTS "supplier_payment_attachments_paymentId_idx"
  ON "supplier_payment_attachments"("paymentId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'supplier_payment_attachments_paymentId_fkey'
  ) THEN
    ALTER TABLE "supplier_payment_attachments"
      ADD CONSTRAINT "supplier_payment_attachments_paymentId_fkey"
      FOREIGN KEY ("paymentId") REFERENCES "supplier_payments"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'supplier_payment_attachments_uploadedById_fkey'
  ) THEN
    ALTER TABLE "supplier_payment_attachments"
      ADD CONSTRAINT "supplier_payment_attachments_uploadedById_fkey"
      FOREIGN KEY ("uploadedById") REFERENCES "users"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END
$$;
