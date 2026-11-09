-- Sales charges say how GST sits on them, and quotations carry charges.
--
-- Until now every charge on a sales order, quotation or invoice was priced as
-- a figure before tax, with GST at the goods' rate added on top: ₹1,200 of
-- transport typed as the final figure became ₹1,260. A charge now has one of
-- three treatments:
--
--   INCLUSIVE    the figure typed already includes GST. The GST inside it is
--                worked out (₹1,200 at 5% holds ₹57.14) and reported; nothing
--                is added on top.
--   EXCLUSIVE    GST is worked out on the figure typed and added on top: the
--                old behaviour.
--   NON_TAXABLE  no GST at all, and outside the value GST is worked out on.
--
-- Nothing already saved changes: every order and invoice charge saved before
-- this was priced with GST added on top, so it is marked EXCLUSIVE and its
-- value without GST (netAmount) is its amount — its totals read exactly as
-- before. New documents take each charge type's own treatment, which starts
-- at INCLUSIVE for every charge type (a charge is typed as the final figure,
-- as purchase charges already are) and can be changed under Masters → Charges
-- or on the document's row.

-- CreateEnum
CREATE TYPE "ChargeTaxTreatment" AS ENUM ('INCLUSIVE', 'EXCLUSIVE', 'NON_TAXABLE');

-- Charge types: the treatment a sale starts with, and whether the charge is
-- taxed at the goods' rate (part of their value) or at its own (a supply of
-- its own). Every charge type keeps following the goods' rate, as since
-- 19 Oct 2026.
ALTER TABLE "charge_types" ADD COLUMN "followsGoodsRate" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "taxTreatment" "ChargeTaxTreatment" NOT NULL DEFAULT 'INCLUSIVE';

-- Invoice charges already saved: GST added on top, value without GST = amount.
ALTER TABLE "sales_invoice_charges" ADD COLUMN "netAmount" DECIMAL(12,2),
ADD COLUMN "taxTreatment" "ChargeTaxTreatment" NOT NULL DEFAULT 'EXCLUSIVE';
UPDATE "sales_invoice_charges" SET "netAmount" = "amount";
ALTER TABLE "sales_invoice_charges" ALTER COLUMN "netAmount" SET NOT NULL;

-- Order charges already saved: the same.
ALTER TABLE "sales_order_charges" ADD COLUMN "netAmount" DECIMAL(12,2),
ADD COLUMN "taxTreatment" "ChargeTaxTreatment" NOT NULL DEFAULT 'EXCLUSIVE';
UPDATE "sales_order_charges" SET "netAmount" = "amount";
ALTER TABLE "sales_order_charges" ALTER COLUMN "netAmount" SET NOT NULL;

-- CreateTable: a quotation's charges, priced as the order's will be.
CREATE TABLE "sales_quotation_charges" (
    "id" TEXT NOT NULL,
    "quoteId" TEXT NOT NULL,
    "chargeTypeId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "taxTreatment" "ChargeTaxTreatment" NOT NULL DEFAULT 'EXCLUSIVE',
    "netAmount" DECIMAL(12,2) NOT NULL,
    "gstRate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "cgst" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "sgst" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "igst" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "sales_quotation_charges_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sales_quotation_charges_quoteId_idx" ON "sales_quotation_charges"("quoteId");

-- CreateIndex
CREATE UNIQUE INDEX "sales_quotation_charges_quoteId_chargeTypeId_key" ON "sales_quotation_charges"("quoteId", "chargeTypeId");

-- AddForeignKey
ALTER TABLE "sales_quotation_charges" ADD CONSTRAINT "sales_quotation_charges_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "sales_quotations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_quotation_charges" ADD CONSTRAINT "sales_quotation_charges_chargeTypeId_fkey" FOREIGN KEY ("chargeTypeId") REFERENCES "charge_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
