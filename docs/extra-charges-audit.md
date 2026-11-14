# Extra charges and GST correction

Baseline: `e366b090` (`fix/purchase-charge-itc-ledger`), the version matching the supplied screenshots. The requested checkout is updated on `fix/erp-charge-gst`; its pre-existing Sidebar change is retained.

## Audit

| Area | Existing implementation | Problem / correction |
| --- | --- | --- |
| Master | `ChargeType`, `master.routes.ts`, `master.schemas.ts`, Masters/Charges | Preserve IDs, separate sales/purchase treatment, classify zero tax, default new configurations exclusive. HSN master is already present; reuse it. |
| Purchase order | `purchase.routes.ts`: resolveCharges/priceOrder; PurchaseOrderDialog | Browser supplied tax rate is trusted; repeated tax controls; percentage becomes an amount. Resolve defaults on server, save configuration and percentage basis. |
| Purchase bill | resolveBillCharges/priceBill; PurchaseBillDialog | Separate resolver, same trust issue; PO copy loses configuration. Use common resolution and pricing with trusted source snapshots. |
| Quotation / sales order | quotation.routes.ts calls prepareOrder; SaleCharges/orderTotals | Live master decides rate on each edit/conversion. Keep saved configuration; ordinary entry should not require treatment selection. |
| Sales invoice / job-work invoice | invoice.routes.ts, salesCharges.ts, SalesInvoiceDialog | Only amount and treatment carried from order; own classification can be incorrectly folded into goods HSN when rates coincide. Preserve classification and snapshots. |
| Shared engine | priceDocument (purchase), priceSale / priceSaleCharge (sales) | Extend existing charge primitive and route both document engines through it; preserve goods pricing and reverse-charge behavior. |
| Reports / posting / print | chargeRowOf/chargeShares, accounts GST and posting, purchase tax buckets | Read saved net value and allocations; do not consult current master to reconstruct history. |
| Indent / enquiry / receipt / delivery challan | Quantity or goods-value documents; no charge-entry table | No additional charge entry to invent. Linked order/invoice owns charges. |
| Operational job cards / contractor settlement | Process prices, not Extra Charges master rows | Preserve process pricing; job-work sales orders and invoices are covered through sales routes. |

## Design and compatibility

Retain existing charge and HSN masters and all transaction relationships. Extend existing fields with purchase amount treatment, sales HSN mapping and separate zero-tax reporting categories. Add a nullable JSON tax snapshot to the five existing charge tables. It records name, classification, rate, inclusive/exclusive treatment, input unit/value, basis and calculated allocations. Existing monetary columns are not rewritten. Historical rows without snapshots continue to use their saved tax values; ambiguous master settings are flagged for review, never inferred from the charge name.

Goods inheritance is an explicit administrator choice for incidental charges, with value-proportional allocation after discounts across all relevant goods rates. It is not automatically selected for transport, packing or freight. Separate services use their own configured HSN/SAC. Neither the charge's name nor a matching GST rate proves that it belongs to goods' HSN.

Tax basis references: [CGST section 15](https://taxinformation.cbic.gov.in/content-page/explore-act/1000284/1000001), [CGST section 8](https://taxinformation.cbic.gov.in/content-page/explore-act/1000277/1000001), [IGST Act](https://cbic-gst.gov.in/hindi/IGST-bill-e.html). The engine applies the transaction's existing place-of-supply context; classification decisions remain explicit master configuration.

## Verification completed

- Existing sale-pricing regression script: 26 checks passed.
- `tools/check-charge-correction.ts`: 25 checks passed, including 120 rounding cases; own HSN, mixed inherited rates, separate zero-tax categories, inclusive/exclusive, fixed/percentage after discounts, reverse charge, master changes, PO/bill conversion and permission enforcement.
- Actual quotation to job-work sales order to invoice API flow reconciles; the invoice accounting voucher balances and GSTR-1 includes the charge exactly once.
- Shared, API and web TypeScript checks passed in the requested checkout.
- Headless Chrome: master settings render independently; saved PO retains original charge name, inclusive amount and rate after a master change; amount edits recalculate the preview; Advanced Tax Settings starts collapsed.
- Both additive migrations applied successfully to isolated local database `lderp_charge_test_20261114`. No migration ran against live data or the demo database. Fixtures were copied from the local demo and test writes were confined to the isolated database. The 10 original charge rows were compared with the demo and retained identical amounts, rates, CGST, SGST and IGST.

## Rollout

Apply the two included migration files using the project's normal Prisma migration deployment process, regenerate Prisma, and deploy the API and web code together. Do not use schema push. Existing masters are flagged for administrator review, including ambiguous zero-rate classifications. Review those settings explicitly; historical charge monetary columns are not rewritten.

Local validation does not replace production verification. The actual invoice, posting and reporting checks cover representative flows; they are not a browser test of every operational screen. The test script requires the isolated database name and local host/port before performing any writes.


## Migration applied - 14 November 2026

Applied all four pending migrations to the checkout-configured Supabase database, schema `ld_erp`: `20261113140000_purchase_charge_gst_mode`, `20261114120000_charge_type_purchase_default`, `20261114150000_charge_configuration_snapshot`, and `20261114150100_charge_explicit_inheritance`. Prisma reports the schema is up to date; the local Prisma client was regenerated. Before/after checksums across all five charge tables confirm saved amounts, GST rates, CGST, SGST and IGST are unchanged. Application deployment is separate and was not performed in this step.
