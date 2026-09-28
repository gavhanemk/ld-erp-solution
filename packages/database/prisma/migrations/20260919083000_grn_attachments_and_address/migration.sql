-- Attachments on a goods receipt, and the frozen address a delivery's
-- paperwork is checked against.
--
-- Hand-written, and additive only — see MIGRATION-NOTES.md for why
-- `prisma migrate dev` is not used on this branch.

-- 1. The frozen address snapshot, plain text like the order's own.
ALTER TABLE "grn"
  ADD COLUMN IF NOT EXISTS "supplierAddress" TEXT;

-- 2. Files kept against a receipt, same shape as purchase_order_attachments.
CREATE TABLE IF NOT EXISTS "grn_attachments" (
  "id"           TEXT NOT NULL,
  "grnId"        TEXT NOT NULL,
  "fileName"     TEXT NOT NULL,
  "storagePath"  TEXT NOT NULL,
  "mimeType"     TEXT,
  "sizeBytes"    INTEGER NOT NULL,
  "uploadedById" TEXT NOT NULL,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "grn_attachments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "grn_attachments_storagePath_key"
  ON "grn_attachments" ("storagePath");

CREATE INDEX IF NOT EXISTS "grn_attachments_grnId_idx"
  ON "grn_attachments" ("grnId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'grn_attachments_grnId_fkey'
  ) THEN
    ALTER TABLE "grn_attachments"
      ADD CONSTRAINT "grn_attachments_grnId_fkey"
      FOREIGN KEY ("grnId") REFERENCES "grn"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'grn_attachments_uploadedById_fkey'
  ) THEN
    ALTER TABLE "grn_attachments"
      ADD CONSTRAINT "grn_attachments_uploadedById_fkey"
      FOREIGN KEY ("uploadedById") REFERENCES "users"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END
$$;
