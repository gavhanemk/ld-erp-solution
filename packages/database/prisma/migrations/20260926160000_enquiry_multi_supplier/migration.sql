-- One enquiry, several suppliers, and their answers compared.
--
-- The first shape of this document held one supplier and his proforma invoice
-- on the enquiry itself. That cannot answer the question the step exists for —
-- which of them is cheapest — without the buyer opening three documents side by
-- side and doing the arithmetic on paper. The old ERP has a whole stage for it
-- ("Supplier Rates"), so the answers move onto their own row per supplier.
--
-- Written in the order the data has to survive: the new tables and columns are
-- made FIRST, every existing enquiry is carried across into a quote of its own,
-- and only then are the old columns dropped. Prisma's own diff put the drops at
-- the top, which would have thrown away the supplier and the PI on every
-- enquiry already on the system before there was anywhere to put them.

-- ── 1. The new tables ───────────────────────────────────────────────────────

CREATE TABLE "purchase_enquiry_quotes" (
    "id" TEXT NOT NULL,
    "enquiryId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3),
    "piNumber" TEXT,
    "piDate" TIMESTAMP(3),
    "piAmount" DECIMAL(12,2),
    "piValidUntil" TIMESTAMP(3),
    "piReceivedAt" TIMESTAMP(3),
    "placeOfSupplyCode" TEXT,
    "remark" TEXT,
    "declinedReason" TEXT,
    "declinedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "purchase_enquiry_quotes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "purchase_enquiry_quote_lines" (
    "id" TEXT NOT NULL,
    "quoteId" TEXT NOT NULL,
    "enquiryLineId" TEXT NOT NULL,
    "quotedRate" DECIMAL(10,2),
    "gstRate" DECIMAL(5,2),
    "offeredQty" DECIMAL(10,3),
    "remark" TEXT,

    CONSTRAINT "purchase_enquiry_quote_lines_pkey" PRIMARY KEY ("id")
);

-- ── 2. The new columns, all nullable ────────────────────────────────────────

ALTER TABLE "purchase_enquiries" ADD COLUMN "locationId" TEXT,
                                 ADD COLUMN "reference" TEXT;
ALTER TABLE "purchase_enquiry_attachments" ADD COLUMN "quoteId" TEXT;
ALTER TABLE "purchase_orders" ADD COLUMN "enquiryQuoteId" TEXT;

-- ── 3. Carry every existing enquiry across ──────────────────────────────────
--
-- One quote per enquiry, holding the supplier it was sent to and whatever his
-- PI said. The quote's id is derived from the enquiry's so the steps below can
-- find it again without a temporary table.

INSERT INTO "purchase_enquiry_quotes" (
  "id", "enquiryId", "supplierId", "sentAt",
  "piNumber", "piDate", "piAmount", "piValidUntil", "piReceivedAt",
  "placeOfSupplyCode", "createdAt", "updatedAt"
)
SELECT
  'mig-' || e."id",
  e."id",
  e."supplierId",
  e."sentAt",
  e."piNumber",
  e."piDate",
  e."piAmount",
  e."piValidUntil",
  e."piReceivedAt",
  e."placeOfSupplyCode",
  e."createdAt",
  e."updatedAt"
FROM "purchase_enquiries" e
WHERE e."supplierId" IS NOT NULL;

-- The rates he gave, one row per line he actually priced. A line he never
-- priced gets no row at all, which is the distinction the new table exists to
-- keep: "he did not quote this" and "he quoted zero" are different answers.
INSERT INTO "purchase_enquiry_quote_lines" (
  "id", "quoteId", "enquiryLineId", "quotedRate", "gstRate"
)
SELECT
  'mig-' || l."id",
  'mig-' || l."enquiryId",
  l."id",
  l."quotedRate",
  l."gstRate"
FROM "purchase_enquiry_lines" l
JOIN "purchase_enquiries" e ON e."id" = l."enquiryId"
WHERE e."supplierId" IS NOT NULL
  AND (l."quotedRate" IS NOT NULL OR l."gstRate" IS NOT NULL);

-- Orders already raised from an enquiry now say which supplier's answer won.
-- There was only ever one, so it is the one just written.
UPDATE "purchase_orders" p
SET "enquiryQuoteId" = 'mig-' || p."enquiryId"
WHERE p."enquiryId" IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM "purchase_enquiry_quotes" q WHERE q."id" = 'mig-' || p."enquiryId"
  );

-- A PI file was filed against the enquiry because there was nowhere else. It
-- belongs to the supplier who sent it.
UPDATE "purchase_enquiry_attachments" a
SET "quoteId" = 'mig-' || a."enquiryId"
WHERE EXISTS (
  SELECT 1 FROM "purchase_enquiry_quotes" q WHERE q."id" = 'mig-' || a."enquiryId"
);

-- ── 4. Only now, the old columns ────────────────────────────────────────────

ALTER TABLE "purchase_enquiries" DROP CONSTRAINT "purchase_enquiries_supplierId_fkey";
DROP INDEX "purchase_enquiries_supplierId_idx";

ALTER TABLE "purchase_enquiries" DROP COLUMN "piAmount",
                                 DROP COLUMN "piDate",
                                 DROP COLUMN "piNumber",
                                 DROP COLUMN "piReceivedAt",
                                 DROP COLUMN "piValidUntil",
                                 DROP COLUMN "placeOfSupplyCode",
                                 DROP COLUMN "sentAt",
                                 DROP COLUMN "supplierId";

ALTER TABLE "purchase_enquiry_lines" DROP COLUMN "gstRate",
                                     DROP COLUMN "quotedRate";

-- ── 5. Indexes and foreign keys ─────────────────────────────────────────────

CREATE INDEX "purchase_enquiry_quotes_supplierId_idx" ON "purchase_enquiry_quotes"("supplierId");
CREATE UNIQUE INDEX "purchase_enquiry_quotes_enquiryId_supplierId_key" ON "purchase_enquiry_quotes"("enquiryId", "supplierId");
CREATE INDEX "purchase_enquiry_quote_lines_enquiryLineId_idx" ON "purchase_enquiry_quote_lines"("enquiryLineId");
CREATE UNIQUE INDEX "purchase_enquiry_quote_lines_quoteId_enquiryLineId_key" ON "purchase_enquiry_quote_lines"("quoteId", "enquiryLineId");
CREATE INDEX "purchase_enquiries_locationId_idx" ON "purchase_enquiries"("locationId");
CREATE INDEX "purchase_enquiry_attachments_quoteId_idx" ON "purchase_enquiry_attachments"("quoteId");
CREATE INDEX "purchase_orders_enquiryQuoteId_idx" ON "purchase_orders"("enquiryQuoteId");

ALTER TABLE "purchase_enquiries" ADD CONSTRAINT "purchase_enquiries_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "warehouses"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "purchase_enquiry_quotes" ADD CONSTRAINT "purchase_enquiry_quotes_enquiryId_fkey" FOREIGN KEY ("enquiryId") REFERENCES "purchase_enquiries"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "purchase_enquiry_quotes" ADD CONSTRAINT "purchase_enquiry_quotes_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "purchase_enquiry_quote_lines" ADD CONSTRAINT "purchase_enquiry_quote_lines_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "purchase_enquiry_quotes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "purchase_enquiry_quote_lines" ADD CONSTRAINT "purchase_enquiry_quote_lines_enquiryLineId_fkey" FOREIGN KEY ("enquiryLineId") REFERENCES "purchase_enquiry_lines"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "purchase_enquiry_attachments" ADD CONSTRAINT "purchase_enquiry_attachments_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "purchase_enquiry_quotes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_enquiryQuoteId_fkey" FOREIGN KEY ("enquiryQuoteId") REFERENCES "purchase_enquiry_quotes"("id") ON DELETE SET NULL ON UPDATE CASCADE;
