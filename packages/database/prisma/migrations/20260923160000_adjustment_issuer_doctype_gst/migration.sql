-- Splits one overloaded column into the three facts it was carrying.
--
-- `noteType` (DEBIT|CREDIT) was answering three different questions at once:
-- who raised the document, what kind of document it is, and which way the
-- money moves. It could express two of the eight real combinations. A supplier
-- debit note — their document, raised by them, INCREASING what we owe — had no
-- representation at all, and would have been recorded as our own debit note
-- reducing the bill. That is money moving the wrong way while reading as
-- correct.
--
-- Safe to restructure rather than backfill: `purchase_notes` holds no rows.
-- Verified before writing this, and the guard below makes the migration fail
-- loudly rather than quietly destroy data if that ever stops being true.

DO $$
BEGIN
  IF (SELECT count(*) FROM "purchase_notes") > 0 THEN
    RAISE EXCEPTION
      'purchase_notes is not empty — this migration drops columns and must be rewritten as a backfill first';
  END IF;
END $$;

-- ── The three new dimensions ───────────────────────────────────────────────

CREATE TYPE "PurchaseAdjustmentIssuer" AS ENUM ('OUR_COMPANY', 'SUPPLIER');

CREATE TYPE "PurchaseAdjustmentDoc" AS ENUM (
  'OUR_DEBIT_NOTE',
  'SUPPLIER_CREDIT_NOTE',
  'SUPPLIER_DEBIT_NOTE',
  'OTHER'
);

CREATE TYPE "PurchaseGstTreatment" AS ENUM (
  'NOT_REVIEWED',
  'GST_CREDIT_NOTE',
  'GST_DEBIT_NOTE',
  'ITC_REVERSAL_ONLY',
  'NO_GST_IMPACT'
);

-- ── The reason list, corrected ─────────────────────────────────────────────
--
-- EXCESS_QUANTITY_BILLED ("the bill shows more than the challan") and
-- SHORT_QUANTITY ("billed for more than arrived") were one event offered
-- twice, which split the reporting for no gain. RATE_DIFFERENCE is renamed to
-- WRONG_RATE so the stored value reads the way the form says it.

CREATE TYPE "PurchaseNoteReason_new" AS ENUM (
  'PURCHASE_RETURN',
  'SHORT_QUANTITY',
  'DAMAGED_MATERIAL',
  'QUALITY_REJECTION',
  'WRONG_MATERIAL',
  'WRONG_RATE',
  'EXCESS_BILLING',
  'POST_PURCHASE_DISCOUNT',
  'OTHER'
);

ALTER TABLE "purchase_notes"
  ALTER COLUMN "reason" TYPE "PurchaseNoteReason_new"
  USING (
    CASE "reason"::text
      WHEN 'RATE_DIFFERENCE' THEN 'WRONG_RATE'
      WHEN 'EXCESS_QUANTITY_BILLED' THEN 'SHORT_QUANTITY'
      ELSE "reason"::text
    END
  )::"PurchaseNoteReason_new";

DROP TYPE "PurchaseNoteReason";
ALTER TYPE "PurchaseNoteReason_new" RENAME TO "PurchaseNoteReason";

-- ── Out with the overloaded column ─────────────────────────────────────────

DROP INDEX IF EXISTS "purchase_notes_noteType_status_idx";
ALTER TABLE "purchase_notes" DROP COLUMN "noteType";
DROP TYPE "PurchaseNoteType";

-- ── In with the three that replace it ──────────────────────────────────────

ALTER TABLE "purchase_notes"
  ADD COLUMN "issuedBy" "PurchaseAdjustmentIssuer" NOT NULL DEFAULT 'OUR_COMPANY',
  ADD COLUMN "docType" "PurchaseAdjustmentDoc" NOT NULL DEFAULT 'OUR_DEBIT_NOTE',
  ADD COLUMN "gstTreatment" "PurchaseGstTreatment" NOT NULL DEFAULT 'NOT_REVIEWED',
  ADD COLUMN "gstNote" TEXT,
  ADD COLUMN "gstTreatedById" TEXT,
  ADD COLUMN "gstTreatedAt" TIMESTAMP(3);

ALTER TABLE "purchase_notes"
  ADD CONSTRAINT "purchase_notes_gstTreatedById_fkey"
  FOREIGN KEY ("gstTreatedById") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "purchase_notes_docType_status_idx" ON "purchase_notes"("docType", "status");
CREATE INDEX "purchase_notes_issuedBy_status_idx" ON "purchase_notes"("issuedBy", "status");

-- ── Numbering for the two document kinds that had none ─────────────────────
--
-- SDN for a supplier's debit note, PADJ for anything the accounts desk
-- classifies as OTHER. Idempotent, and skipped entirely for any company that
-- already has a series for that docType — the duplicate PO series that cost a
-- number earlier came from an insert exactly like this one without the guard.

-- Two series, written the same way the SCN series was: for every company that
-- has none yet, so re-running is harmless and a database seeded later still
-- gets one. `financialYear` is NOT NULL, and one series per docType rather
-- than one per year — a series per year is what produced a duplicate PO
-- series and cost a document number.

INSERT INTO "number_series" (
  "id", "companyId", "docType", "prefix", "separator",
  "financialYear", "lastNumber", "padding", "isActive"
)
SELECT
  gen_random_uuid()::text,
  c."id",
  s.doc,
  s.doc,
  '-',
  COALESCE(NULLIF(c."currentFY", ''), '2627'),
  0,
  4,
  true
FROM "company" c
CROSS JOIN (VALUES ('SDN'), ('PADJ')) AS s(doc)
WHERE NOT EXISTS (
  SELECT 1 FROM "number_series" ns
  WHERE ns."companyId" = c."id" AND ns."docType" = s.doc
);
