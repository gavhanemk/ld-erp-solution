# Database changes — running notes

One entry per migration that is not yet merged into `main`, so anybody pulling
knows what happened to the database and what they have to do about it.

Delete an entry once its branch is merged and everybody has pulled.

---

## 28 Sep 2026 — BOM costing and pricing

**Migration:** `20260928100000_bom_costing_and_pricing`
**Branch:** `feat/masters-bom-costing`
**Status: applied to the shared database on 28 Sep.** Nobody needs to apply it.
It was dry-run first inside a transaction that was rolled back, then applied with
`prisma migrate deploy`.

### What changed

| Table | Change |
|---|---|
| `bom` | New `overheadCost`, `costPerPiece`, `marginPercent`, `sellingPrice`, `pricedById`, `pricedAt` |
| `bom_lines` | New `customerSupplied` (default false). **Unused:** the "supplied by customer" tick it was for was removed from the form on the same day, before merging. Every row is false and no code reads it. Dropping it would need another migration |
| `bom_cost_lines` | New table: a BOM's labour and overhead rows (kind, name, optional department, ₹ per piece or %, the typed value, the worked-out amount) |

Two new enums: `BOMCostKind` (LABOUR, OVERHEAD) and `BOMCostBasis` (PER_PIECE, PERCENT).

### Rows it touched

Labour used to be read off a BOM's linked routing. The migration wrote each rated
routing step as a labour row, so no BOM's labour changed. On 28 Sep that was one BOM:
LD-SH-2601 White, 9 rows, ₹70.50. It also set `costPerPiece` to material + labour
and `overheadCost` to 0 on every BOM with a cost. Nothing was dropped or renamed.

### What you have to do

Nothing, unless your branch has no copy of this folder. Then `prisma migrate dev`
will offer to drop the new table and columns. Say no; `prisma migrate deploy` is safe.

---

## 17 Sep 2026 — one bill of materials per colour, and a department on each line

**Migration:** `20260917100000_bom_colour_and_process`
**Branch:** `feat/masters-bom-colour-and-process` (stacked on `feat/masters-bom-size-routing-status`)
**Status: applied to the shared database on 17 Sep, during the migration hold.**
Nobody needs to apply it.

### Applied during the hold — deliberately

On 16 Sep the team agreed nobody runs a migration until `main` catches up with the
database. This one went in anyway, on 17 Sep, so the colour and department work
could be tested; that was a decision, not an accident. It is five statements, adds
two columns, and touches no rows. The folder is pushed on the branch above, so the
database can still be rebuilt from the repository.

What it means for everyone else: **`main` is one more migration behind the database.**
On any branch without this folder, `prisma migrate dev` will propose dropping
`bom.color` and `bom_lines.departmentId`. Say no. `prisma migrate deploy` is safe.

### What changed

| Table | Change |
|---|---|
| `bom` | New `color` column. The unique key becomes style + colour + version, so White v1.0 and Dusty Blue v1.0 of one style are two BOMs |
| `bom_lines` | New `departmentId` — the department that draws the component from the store |

The old `bom_styleId_version_key` index is dropped only so the wider one can replace
it. No rows are added, changed or removed.

### Why one BOM per colour

The production team, accounts, and the people who use the old ERP asked for it: a
white shirt and a dusty blue one take different cloth, and the old system made one
BOM per colourway. Approving a BOM now retires the previous approved one **of the
same colour only** — approving White must leave Dusty Blue alone.

### The four BOMs already in the database

All four keep a blank colour. Each belongs to a style offered in two or three
colours, so there is no single right colour to fill in, and guessing would be worse
than a blank. The screen marks them **Colour not set**. To give one its colours,
copy it to each colour, change the fabric line, approve each copy, and retire the
original.

### Why the department

A material requisition is always raised by one department. With the department on
each BOM line, an order's materials can be asked for stage by stage — Cutting takes
the fabric, Stitching the thread and labels, Packing the cartons — instead of all
at once. It is optional; the screen flags lines where it is missing.

### Written by hand, like the one before

`migrate dev` would also drop columns belonging to the unmerged `feat/purchase`
branch, which are live in the database. This migration holds only its own five
statements.

---

## 16 Sep 2026 — the bill of materials gains sizes, a routing and a status

**Migration:** `20260916104500_bom_size_routing_and_status`
**Branch:** `feat/masters-bom-size-routing-status`
**Status: already applied to the shared database.** Nobody needs to apply it.

### What changed

One new table and seven new columns. Nothing was renamed, dropped or emptied.

| Table | Change |
|---|---|
| `bom_line_sizes` | New. One row per size whose consumption differs from the line |
| `bom` | `routingId`, `baseSizeId`, `status`, `approvedById`, `approvedAt`, `copiedFromId`, `labourCost` |
| `bom_lines` | `component` — which part of the garment, "Body", "Collar" |

Plus an index on `bom.status` and the two foreign-key indexes `bom_lines` never
had, so a BOM read stops being a sequential scan.

### The backfill, and what it deliberately left alone

`status` defaults to `DRAFT`. Left at that, every BOM already being costed
against would read as a draft nobody had agreed to, so the migration promotes
the settled ones:

```sql
UPDATE "bom" b SET "status" = 'APPROVED'
WHERE b."isActive"
  AND (SELECT count(*) FROM "bom" x
       WHERE x."styleId" = b."styleId" AND x."isActive") = 1;
```

Only where a style has **exactly one** active BOM. Where two are active there is
no way to tell which one the floor is working to, and those stay `DRAFT` for a
person to decide — guessing would be the very ambiguity the column exists to
end. All four BOMs on the database were unambiguous and are now `APPROVED`.

### Why this migration was written by hand

`prisma migrate dev` could not be used. The live database carries leftovers that
no branch defines any more — `purchase_order_attachments`, and
`enquiryNo` / `enquiryDate` / `reference` / `remark` / `deliveryCustomerId` on
`purchase_orders`, plus `grnLineId` on `purchase_invoice_lines` and a couple of
`createdById` columns. They date from the init migration that went in through
the Supabase connector. Prisma wants to drop all of them.

**They are all empty** — checked before this went in — so clearing them up is
safe whenever somebody wants to. It just is not a bill-of-materials job, and
burying it inside this migration would have been a nasty surprise in the pull
request. Until then, expect `migrate dev` to keep proposing those drops. Say no.

### One thing that nearly went wrong

Before this, `main` did not have the stock-documents models, but the database
did. Running `migrate dev` from `main` would have dropped `stock_transfers` and
`stock_adjustments` with their lines — real rows, and 61 `stock_ledger` entries
beside them. `feat/inventory-stock-documents` has now been merged into `main`,
which is what closed that gap. Worth remembering that `prisma migrate status`
says "up to date" in exactly that situation: it checks which migrations ran, not
whether the schema still matches.

---

## 23 Sep 2026 — a separate right to post

**Migration:** none. This is a seed change.
**Branch:** `fix/purchase`
**Status: already applied to the shared database.** Nobody needs to apply it.

### What changed

`post` was added to the permission matrix, so it now runs seven actions across
thirteen modules — 91 rows rather than 78. Only one route guards on it:
posting a purchase note.

| Role | `purchase:post` |
|---|---|
| Admin | yes (and short-circuits everything anyway) |
| MD | yes |
| Accounts Manager | **yes — this is the point of the change** |
| Store Manager | yes, via its existing `full('purchase')` |

### Why not just use `approve`

The accounts desk has to put a debit or credit note through the books. Under
the old matrix that meant granting them `purchase:approve` — which would also
have let them approve purchase orders, because permissions are per module and
not per document. A purchase manager agreeing that the mill is owed money and
accounts deciding when it comes off the payable are two different decisions by
two different desks, and docs/04-business-rules.md keeps them apart.

Verified over HTTP with a throwaway Accounts user, since none is seeded with a
known password:

```
approve -> 403  purchase:approve
create  -> 403  purchase:create
post    -> 200  "ZZTEST-P1 posted. PB-2627-0001 now stands at ₹19,300."
```

The user, its audit row and the fixture note were removed afterwards.

### How it was applied

`seedCore` is upserts throughout, so from `packages/database`:

```bash
npx tsx prisma/seed.ts
```

It rewrites no data — it adds the thirteen new permission rows and the grants.

## 23 Sep 2026 — debit and credit notes against a supplier

**Migration:** `20260923090000_purchase_debit_credit_notes`
**Branch:** `fix/purchase`
**Status: already applied to the shared database.** Nobody needs to apply it.

### What changed

Purely additive. Three new tables, four new enums, one new column. **Nothing
was renamed and nothing was dropped**, which was a deliberate choice — see
below.

| Table | Holds |
|---|---|
| `purchase_notes` | One row per debit or credit note against a supplier |
| `purchase_note_lines` | What is coming off, each pointing at the bill line it adjusts |
| `purchase_note_attachments` | The evidence — rejection report, photo, their note |

| Column | Holds |
|---|---|
| `purchase_invoices.noteAdjustment` | Net effect of POSTED notes. `NOT NULL DEFAULT 0` |

New enums: `PurchaseNoteType`, `PurchaseNoteReason`, `PurchaseNoteEffect`,
`PurchaseNoteStatus`.

The migration also inserts an `SCN` numbering series for every company that has
none, taking the financial year from `company.currentFY`. Its own series rather
than the existing `CN`, which belongs to the sales credit note — that is an
outward document whose numbering has to be unbroken under Rule 46, and sharing
it would punch holes in it from the purchase office.

### Why `debit_notes` is still there

`PurchaseNote` replaces `DebitNote` entirely. Nothing in the application reads
or writes the old two tables any more. They were **not** dropped, and the models
are still in `schema.prisma` under an `AWAITING REMOVAL` banner, because the API
deployed on Render runs from `main` — and `main`'s `billInclude` joins
`debit_notes` on **every read of a purchase bill**. Dropping or renaming that
table would have broken the live bill list and every bill detail on the deployed
site, days before the branch that replaced it merges.

Both old tables were empty when this ran, so nothing had to be migrated across.

**When this branch merges and Render redeploys:** delete `DebitNote`,
`DebitNoteLine` and their three relation fields — `Supplier.debitNotes`,
`Item.debitLines`, `PurchaseInvoice.debitNotes` — and let the next migration
drop the tables.

### The one behaviour change outside the new tables

`syncBillFromPayments` in `purchase.routes.ts` now subtracts `noteAdjustment`
alongside TDS when working out what is left to settle:

```
settleable = totalAmount − tdsAmount − noteAdjustment
```

`syncBillAdjustments` in `purchaseNote.service.ts` computes the same figure from
the other end. **The two must agree.** If they ever diverge the balance will
flip every time a note or a payment is touched.

### How it was applied

From `packages/database`, on 23 Sep 2026:

```bash
PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK=true npx prisma migrate deploy
```

The environment variable is needed because the advisory lock Prisma takes does
not survive Supabase's connection pooler — without it the deploy times out
after ten seconds on `pg_advisory_lock`.

### A note on the shared database's drift

Unrelated to this change, and found while generating the migration:
`prisma migrate diff --from-schema-datasource` reports that the live database
still has `bom.approvedById`, `bom.status`, `bom.color`, `items.styleId`,
`items.color` and the `bom_line_sizes` table, none of which `schema.prisma`
declares any more. `prisma migrate status` says "up to date" because it only
compares migration *names*.

This migration was generated by diffing schema against schema, so it carries
none of that. But the next person who runs `prisma migrate dev` will be offered
a migration that **drops those columns and that table**. Worth settling before
somebody accepts it without reading.

---

## 22 Sep 2026 — a record may not outlive what it describes

**Migration:** `20260922160000_purchase_integrity_and_payment_reversal`
**Branch:** `fix/purchase`
**Status: already applied to the shared database.** Nobody needs to apply it.

### What changed

Three foreign keys moved from `ON DELETE SET NULL` to `ON DELETE RESTRICT`, and a
supplier payment gained a status so it can be reversed rather than deleted.

| Key | Was | Now |
|---|---|---|
| `purchase_invoice_lines.grnLineId` | SET NULL | RESTRICT |
| `grn_lines.poLineId` | SET NULL | RESTRICT |
| `supplier_payments.invoiceId` | SET NULL | RESTRICT |

| Column | Holds |
|---|---|
| `supplier_payments.status` | `POSTED` or `REVERSED`. `NOT NULL DEFAULT 'POSTED'` |
| `reversedAt`, `reversedById`, `reversalReason` | Who reversed it, when, and why |

Plus a check constraint, `supplier_payments_reversal_is_explained`: a row marked
REVERSED must carry all three. A reversal with no reason is unauditable, and
the database is the only place that can insist on it.

### Why the three keys

Every one of them had a guard in the API that could never fire.

The goods receipt delete route catches Postgres error P2003 and answers
"that receipt has a bill matched against it — remove it from that bill
first." P2003 was impossible: the database nulled the bill line instead. So
the receipt went, its stock came back out, and the bill kept a line pointing
at nothing — never three-way matched again, with nothing on it to say why.

That was proved in a rolled-back transaction before the change, and the same
script proves it shut after:

```
DELETE receipt  -> REFUSED by the database (P2003). Hole shut.
DELETE PO line  -> REFUSED by the database (P2003). Hole shut.
REVERSED with no reason -> REFUSED by the check constraint.
```

### The one thing that had to change with it

Correcting a goods receipt used to delete every line and write fresh ones,
which gave each a new id. Under the restrict key that would have refused any
edit to a receipt that had been billed — including correcting its vehicle
number. So the receipt patch now diffs: a line still on the receipt keeps its
identity and is updated in place, only a line genuinely gone is deleted, and a
line a bill is holding cannot go at all.

It also now refuses to correct a line *down* below what a bill already claims:

> Collar Clip is billed at 650 on PB-2627-0001, so this receipt cannot be
> corrected down to 400. Correct the bill first.

That check never existed. `checkAgainstReceipts` asks whether a bill is running
ahead of its receipts; nothing asked whether a receipt was being corrected
back behind its bills.

### How it was applied

From `packages/database`, on 22 Sep 2026:

```bash
npx prisma db execute --file prisma/migrations/20260922160000_purchase_integrity_and_payment_reversal/migration.sql --schema prisma/schema.prisma
npx prisma migrate resolve --applied 20260922160000_purchase_integrity_and_payment_reversal
```

Changing a referential action is a DROP and re-ADD of the constraint. No row
is read or written by it; the re-ADD validates that existing values still
point at rows that exist, which was checked first and found clean — 0 of 2
bill lines and 0 of 2 receipt lines were already orphaned.

Row counts before and after — **identical on every table**: purchase_orders 4,
purchase_order_lines 6, grn 2, grn_lines 2, purchase_invoices 1,
purchase_invoice_lines 2, supplier_payments 0, debit_notes 0, suppliers 17,
items 43, stock_ledger 93, users 5, bom 5, bom_lines 42.

### What you have to do

Nothing to the database.

```bash
git pull
pnpm install
pnpm db:generate     # stop the API first — Windows locks the Prisma engine file
```

Without `db:generate` your Prisma client does not know `supplier_payments.status`
exists and every read of a payment fails.

---

## 22 Sep 2026 — a supplier payment records what the mill's own voucher records

**Migration:** `20260922060000_supplier_payment_voucher_details`
**Branch:** `fix/purchase`
**Status: already applied to the shared database.** Nobody needs to apply it.

### What changes

Four nullable-or-defaulted columns on `supplier_payments`, two foreign keys,
and one new table. Additive only: nothing renamed, nothing dropped, no existing
row rewritten. There are **no payments on the system at all**, so nothing can
be affected either way.

| Column | Holds |
|---|---|
| `warehouseId` | Where the payment is booked — the old ERP's "Location". Empty is head office |
| `bankAccountId` | The account the money left — the old ERP's "Paid Through" |
| `chequeNo` | As written on the cheque |
| `tdsAmount` | Tax withheld from this payment. `DECIMAL(12,2) NOT NULL DEFAULT 0` |

| Table | Holds |
|---|---|
| `supplier_payment_attachments` | The bank advice, the counterfoil, the UTR screenshot |

### Why

Surveyed against the mill's Absolute ERP payment voucher. Its form has ten
boxes; ours had five, and the five that were missing are the ones an accounts
query actually turns on — which account the money left, which cheque it was,
and the papers that prove it. A payment nobody can tie to a line on a bank
statement is a payment nobody can defend.

`chequeNo` is the odd one out: we were already asking for a cheque number and
writing it into `referenceNo`, which sat beside a `chequeDate` that had
nothing to pair with. It has its own column now, and `referenceNo` goes back to
meaning the UTR or transaction reference.

### The two decisions worth knowing

**Both foreign keys are `ON DELETE RESTRICT`, not `SET NULL`.** A payment
that has forgotten which account it came out of cannot be reconciled, and that
is the single thing the record exists to support. Retiring an account or a
store is what their `isActive` flags are for. (This is the same trap that
makes `purchase_invoice_lines.grnLineId` orphan a bill line when a billed
receipt is deleted — worth not repeating.)

**Tax is deducted once.** A bill already carries `tdsSection`, `tdsRate` and
`tdsAmount`, and `syncBillFromPayments` already settles the bill net of it.
The new column is for the other case — the deduction decided at payment time,
which previously had nowhere to go and left the bill sitting part-paid for
ever. The API refuses a payment-level deduction on a bill that already carries
one, and the dialog does not offer the tick there at all.

Both now count toward settling: `balance = (total − bill TDS) − paid −
withheld at payment`.

### Why it is hand-written

Same reason as every entry below. `prisma migrate diff` against the live
database on 22 Sep still wants to:

```sql
DROP TABLE "bom_line_sizes";
DROP COLUMN "styleId";          -- items
DROP COLUMN "approvedById";     -- bom, and seven more
DROP TYPE "BOMStatus";
```

That is the other team's applied work. **The answer is still no.** The SQL in
the migration folder is the four columns, the two keys, the table and its
indexes, and nothing else.

### How it was applied

From `packages/database`, on 22 Sep 2026:

```bash
npx prisma db execute --file prisma/migrations/20260922060000_supplier_payment_voucher_details/migration.sql --schema prisma/schema.prisma
npx prisma migrate resolve --applied 20260922060000_supplier_payment_voucher_details
```

`db execute` runs the file and never diffs the schema, so it cannot offer to
reset anything. `migrate resolve` then records it as applied. Every statement
is guarded with `IF NOT EXISTS`, so running it twice is safe.

Then, with the API stopped — Windows locks the Prisma engine file:

```bash
pnpm db:generate
```

Row counts taken immediately before and again immediately after — **identical
on every table**:

| Table | Before | After |
|---|---|---|
| `purchase_orders` | 4 | 4 |
| `purchase_order_lines` | 6 | 6 |
| `grn` | 2 | 2 |
| `grn_lines` | 2 | 2 |
| `purchase_invoices` | 1 | 1 |
| `supplier_payments` | 0 | 0 |
| `suppliers` | 17 | 17 |
| `items` | 43 | 43 |
| `stock_ledger` | 93 | 93 |
| `users` | 5 | 5 |
| `bom` | 5 | 5 |
| `bom_lines` | 42 | 42 |
| `bank_accounts` | 3 | 3 |
| `warehouses` | 5 | 5 |

The BOM tables the generated diff wanted to drop were checked afterwards and
are all still there: `bom` (5), `bom_lines` (42), `bom_line_sizes` and `items.styleId`
both intact.

The route's own query was then run against the migrated database — the full
`paymentInclude`, and the aggregate the bill-settling math depends on. Both
returned cleanly.

### What you have to do

Nothing to the database.

```bash
git pull
pnpm install
pnpm db:generate     # stop the API first — Windows locks the Prisma engine file
```

Without `db:generate` your Prisma client does not know the four columns exist
and every read of `supplier_payments` fails with `The column
supplier_payments.warehouseId does not exist` — which is exactly what the
Supplier Payments screen showed between the code landing and the SQL running.
Orders, receipts, bills, stock and the masters are unaffected.

---

## 18 Sep 2026 — a goods receipt records the delivery it came from

**Migration:** `20260918064500_grn_delivery_details`
**Branch:** `feat/purchase`
**Status: already applied to the shared database.** Nobody needs to apply it.

### What changes

Fourteen nullable columns on `grn`, and one foreign key. Additive only:
nothing renamed, nothing dropped, no existing row rewritten. There are no
receipts on the system yet, so nothing can even be affected.

| Column | Holds |
|---|---|
| `gateEntryNo`, `gateEntryDate` | The security gate's own record, written before the goods reach the store |
| `challanNo`, `challanDate` | The supplier's delivery challan — the paper that travels with the goods |
| `supplierBillNo` | The bill number as handed over at the gate |
| `supplierInvoiceNo`, `supplierInvoiceDate` | The supplier's invoice, caught on arrival |
| `packageCount` | Bales, cartons or rolls off the vehicle |
| `driverName` | |
| `formNo`, `clientName`, `orderedBy`, `referenceNo` | Reference numbers from other people's systems |
| `createdById` | Who recorded it. Prints as "Prepared By" |

`createdById` is `ON DELETE SET NULL`, not cascade: somebody leaving the mill
must not take the goods receipts they recorded with them.

### Why

Surveyed off the mill's live Absolute ERP on 18 Sep 2026. Every one of these
had a box on its GRN form, and they are what settles a query about a supplier's
bill months later — the gate entry is our own independent trace that a lorry
came, and the challan is what physically travelled with the goods. A receipt
that cannot be tied back to a physical delivery is one nobody can defend.

All of them are optional. The person typing is at the gate with a lorry
waiting, and a receipt refused because the driver's name was blank would put
the stock figure behind the goods.

### Why it is hand-written

`prisma migrate dev` cannot be used. The generated diff for this change was
read first, and alongside the fourteen `ADD COLUMN`s it contained:

```sql
DROP TABLE "bom_line_sizes";
DROP COLUMN "departmentId";
DROP TYPE "BOMStatus";
```

That is the other team's BOM work, which is applied to the shared database and
is still not in this repo's schema. Prisma reads it as drift and offers to
"fix" it by deleting it. **The answer is still no.** The SQL in the migration
folder is the fourteen columns and the key, and nothing else.

### How it was applied

```bash
cd packages/database
npx prisma db execute --file prisma/migrations/20260918064500_grn_delivery_details/migration.sql --schema prisma/schema.prisma
npx prisma migrate resolve --applied 20260918064500_grn_delivery_details
```

`db execute` runs the file and never diffs the schema, so it cannot offer to
reset anything. `migrate resolve` then records it as applied so the next person
is not told it is pending.

Row counts taken immediately before and again immediately after — **identical
on every table**:

| Table | Before | After |
|---|---|---|
| `purchase_orders` | 1 | 1 |
| `purchase_order_lines` | 1 | 1 |
| `purchase_order_charges` | 1 | 1 |
| `grn` | 0 | 0 |
| `grn_lines` | 0 | 0 |
| `purchase_invoices` | 0 | 0 |
| `suppliers` | 17 | 17 |
| `items` | 43 | 43 |
| `stock_ledger` | 61 | 61 |
| `users` | 5 | 5 |

The BOM tables the generated migration wanted to drop were checked afterwards
and are all still there, columns intact: `bom` (16), `bom_lines` (12),
`bom_line_sizes` (6).

### What you have to do

Nothing to the database.

```bash
git pull
pnpm install
pnpm db:generate     # stop the API first — Windows locks the Prisma engine file
```

Without `db:generate` your Prisma client does not know the fourteen columns
exist and every read of `grn` fails with `The column grn.gateEntryNo does not
exist`. Orders, bills, stock and the masters are unaffected.

---

## 8 Sep 2026 — stock transfers and stock adjustments become documents

**Migration:** `20260908102141_add_stock_transfer_and_adjustment_documents`
**Branch:** `feat/inventory-stock-documents`
**Status: already applied to the shared database.** Nobody needs to apply it.

### Read this first

We have **one** database. Everybody's `apps/api/.env` points at the same
Supabase project, so a migration run on one machine is a migration run for
everyone. This one went in on 8 September.

That means the four new tables already exist for you. What you are missing is
only the **code** that uses them, which is on the branch above.

### What changed

Four new tables:

| Table | Holds |
|---|---|
| `stock_transfers` | Moving stock from one of our stores to another |
| `stock_transfer_lines` | What moved, and what it was carried at |
| `stock_adjustments` | A correction after somebody counted the rack |
| `stock_adjustment_lines` | What the book said against what was counted |

Two new numbering series, `STN` for the transfer note and `ADJ` for the
adjustment. They are added by `pnpm db:seed`, which is safe — it only fills in
what is missing.

**Nothing existing was changed, renamed or deleted.** The migration only
creates. No existing table was altered and no data was touched. That is worth
knowing because it means the change could not have broken anything already
there.

### Why it was needed

A stock transfer and a stock adjustment used to leave nothing behind but ledger
rows tagged with the clock:

```
reference: ADJ-1788857668962
```

That points at nothing. There was no way to list what had been corrected this
month, see who did it or why, or reprint the slip that goes with moved goods.
Compare a goods receipt row, which points at a real record you can open as
GRN-2627-0002. The new tables give transfers and adjustments the same footing.

### What you have to do

Nothing to the database. On your own machine, once the branch is merged (or if
you check it out to try it):

```bash
git pull
pnpm install
pnpm db:generate     # stop the API first — Windows locks the Prisma engine file
```

`db:generate` is the one that matters. Without it your Prisma client has no idea
those tables exist and the API will not compile.

### The one thing that could go wrong

**Do not run `pnpm db:migrate` while you are on a branch that does not have this
migration** — `main`, or a branch cut before 8 September.

Prisma compares the database against your local migrations folder. It will find
a migration in the database that is not on your disk, decide the two have drifted
apart, and offer to **reset the database to fix it**. Resetting means dropping
everything: every order, every stock movement, every user.

If you ever see a prompt asking to reset the database, the answer is **no**.
Then pull, or check out the branch that has the missing migration, and try again.

This is exactly why the handbook says to merge a schema change the same day
rather than sit on it. The gap is open until `feat/inventory-stock-documents`
lands.

To check where you stand, read the entries in this file and make sure your
branch has every migration they list:

```bash
ls packages/database/prisma/migrations
```

If one of them is missing from that folder, the database is ahead of you. Get
the missing branch first. Do not migrate.

> **Do not use `prisma migrate status` for this.** It was recommended here and
> it does not work. Run on `main` on 15 Sep 2026, with the database three
> migrations ahead, it printed "Database schema is up to date!" and exited 0.
> It reports migrations you have and the database does not — the opposite of
> the direction that puts the data at risk.
>
> What does show it is a diff against the live database:
>
> ```bash
> cd packages/database
> npx prisma migrate diff --from-schema-datasource prisma/schema.prisma \
>   --to-schema-datamodel prisma/schema.prisma --script
> ```
>
> On a branch that is level this prints "This is an empty migration." If it
> prints `DROP TABLE` for tables somebody else added, you are behind and
> migrating would offer to delete them.

### When the API goes live

Migrations do not run by themselves on the server. After merging a schema
change, somebody has to run:

```bash
pnpm --filter @ld-erp/database migrate:prod
```

That runs `prisma migrate deploy`, which only applies what is pending. It never
resets, which is why it is the right command against anything real.

(This said `migrate:deploy`, which is not a script that exists — the command
would have failed at the moment somebody needed it to work.)

---

## 15 Sep 2026 — a purchase bill points at the goods receipt it settles

**Migration:** `20260915122040_purchase_bill_receipt_match`
**Branch:** `feat/purchase-bills`
**Status: already applied to the shared database.** Nobody needs to apply it.

### What changed

Four additions to tables that were empty, and nothing renamed or dropped:

| Table | Change |
|---|---|
| `purchase_invoice_lines` | `grnLineId` — the receipt line this bill line settles |
| `purchase_invoices` | `createdById` — who booked it |
| `supplier_payments` | `createdById` — who paid it |
| `purchase_invoices` | unique on `(supplierId, supplierInvoiceNo)` |

### Why it was needed

A bill could be booked for more than was ever received, and nothing would
notice. The receipt link makes the three-way match possible — ordered, received
and billed have to agree one row at a time. It sits on the line rather than on
the bill because a supplier routinely bills several deliveries together, and
because a bill line for something never received is exactly the case the match
has to catch.

The unique index stops the same supplier invoice being booked twice, which would
claim the input credit twice. Neither a bill nor a payment recorded who entered
it, so the audit trail could not answer the question it exists for.

### What you have to do

Nothing to the database. On your machine, once the branch is merged:

```bash
git pull
pnpm install
pnpm db:generate     # stop the API first — Windows locks the Prisma engine file
```

---

## 15 Sep 2026 — a purchase order remembers the quotation it answers

**Migration:** `20260915151556_purchase_order_enquiry_and_reference`
**Branch:** `feat/purchase-order-form`
**Status: already applied to the shared database.** Nobody needs to apply it.

### What changed

Four optional columns on `purchase_orders`. Nothing renamed, nothing dropped,
no existing data touched — every order already on the system predates them and
simply has them empty.

| Column | Holds |
|---|---|
| `enquiryNo` | The supplier's quotation number this order answers |
| `enquiryDate` | The date on that quotation |
| `reference` | Whatever the mill needs to quote back — a job number, an indent slip |
| `remark` | An internal note. Not printed on the supplier's copy, unlike `notes` |

### Why it was needed

The first question asked when a price is queried months later is which quote it
came from, and that answer lived only in somebody's email.

### What you have to do

Nothing to the database. Same three commands as the entry above.

---

## 16 Sep 2026 — a supplier can deliver straight to a customer

**Migration:** `20260916102317_purchase_order_deliver_to_customer`
**Branch:** `feat/purchase`
**Status: already applied to the shared database.** Nobody needs to apply it.

### What changed

Two optional columns on `purchase_orders`, and a foreign key.

| Column | Holds |
|---|---|
| `deliveryCustomerId` | The customer the supplier ships to, instead of us |
| `deliveryAddress` | That address as it read the day the order was raised |

Nothing renamed, nothing dropped. Every order already on the system goes to one
of our own warehouses and simply has both empty.

### Why it was needed

It is not only a delivery note — it changes the tax. Goods are taxed where they
are delivered, so a supplier in our own state billing us for goods sent to a
customer in another state raises IGST, not CGST/SGST. The old form had nowhere
to say that, so the split came out wrong on exactly the orders where it mattered.

The address is copied rather than looked up each time, because a customer moves
and an order already sitting with a supplier must not change under it.

### What you have to do

Nothing to the database.

```bash
git pull
pnpm install
pnpm db:generate     # stop the API first — Windows locks the Prisma engine file
```

---

## 16 Sep 2026 — files kept against a purchase order

**Migration:** `20260916103224_purchase_order_attachments`
**Branch:** `feat/purchase`
**Status: already applied to the shared database.** Nobody needs to apply it.

### What changed

One new table, `purchase_order_attachments`. No existing table was touched.

The file itself does **not** live in the database. The row records where the
file sits in object storage, what the person originally called it, its size and
type, and who uploaded it. A blob in a row would slow down every query that
touches the order.

`storagePath` is unique, so two rows can never claim the same file. Deleting an
order takes its attachment rows with it (`ON DELETE CASCADE`); deleting the
*file* is the API's job, not the database's.

### There is also a storage bucket

This migration is only half of it. The files need a private Supabase bucket
named `ld-erp-documents`, limit 50MB, which **already exists** on our project —
it is not created by any migration, so a fresh project would need it made by
hand. The API reads its name from `SUPABASE_BUCKET`, falling back to that.

The bucket must be **private**. A purchase order carries prices and terms, and a
public bucket URL is one that can be guessed, shared and indexed. Every download
goes through a link the API signs, which dies after five minutes.

Two API environment variables are required, and the API returns a plain 501 with
an explanation if they are missing rather than failing oddly:

```
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
```

The service role key never leaves the server.

### What you have to do

Nothing to the database. Same three commands as the entry above, plus the two
environment variables in `apps/api/.env` if you want uploads working locally.

---

## 16 Sep 2026 — charges, a style number, and the order type on a purchase order

**Migration:** `20260916152235_purchase_order_charges_and_style`
**Branch:** `feat/purchase`
**Status: already applied to the shared database.** Nobody needs to apply it.

### What changed

| Change | Where |
|---|---|
| New table `purchase_order_charges` | transport, freight and dyeing on an order |
| `otherCharges` | `purchase_orders` — a catch-all that carries no GST |
| `styleId` | `purchase_order_lines` — the garment style the material is bought for |

Additive only: two `ADD COLUMN`, one `CREATE TABLE`, and their keys. Nothing
renamed, nothing dropped. Every order already on the system keeps its figures
and simply has no charges and no style.

`poType` was **not** part of this migration. That column has existed since the
first migration; nothing had ever set it, so every order carried the default.
The form writes it now — no schema change was needed.

### Why a table rather than six columns

The old ERP had five fixed charge rows — transport at 5%, freight at 12% and
18%, dyeing at 18% and 5%. Six named columns would have been quicker and would
have baked today's GST rates into column names; the mill has re-rated these
before. `PurchaseOrderCharge` is deliberately the same shape as
`PurchaseInvoiceCharge`, so a charge agreed on the order and the charge that
turns up on the bill can be compared row for row by the three-way match.

The rows on the form are the rows in **Masters → Charges** where "apply on
purchase" is ticked. Add one there and a row appears on the order; change its
GST rate there and the order follows. Two charge types were added to make up
the old form's five: *Freight / Courier (Transporter)* at 12% and *Dyeing
Charges (Processing)* at 18%. Rename them there if the mill words them
differently — nothing in the code matches on the name.

A charge's GST rate is **copied onto the order row** when it is raised, not
read live. A rate corrected in the master next week must not silently change
what an order already sent to a supplier was taxed at.

### How this one was applied, and why it matters

Not with `pnpm db:migrate`. The shared database still had a migration this repo
does not (`20260916104500_bom_size_routing_and_status`), so `prisma migrate
dev` would have compared our schema to the database, found the BOM tables
unexplained, and offered to drop them — 4 BOMs, 39 BOM lines, 5 routings and 46
routing steps of real data.

Instead the SQL was hand-written, checked for destructive statements, applied
with `prisma db execute` — which runs the file and never diffs the schema — and
then recorded with `prisma migrate resolve --applied`. Row counts were taken
before and after and every existing table was unchanged.

**The same warning still stands: do not run `pnpm db:migrate`** until the BOM
migration is in this repo. It sits on `origin/feat/masters-bom-size-routing-status`.

### What you have to do

Nothing to the database.

```bash
git pull
pnpm install
pnpm db:generate     # stop the API first — Windows locks the Prisma engine file
```

---

## 16 Sep 2026 — the style number as the buyer types it

**Migration:** `20260916163807_purchase_order_line_style_no`
**Branch:** `feat/purchase`
**Status: already applied to the shared database.** Nobody needs to apply it.

### What changed

One nullable column, `styleNo`, on `purchase_order_lines`. Additive: nothing
renamed, nothing dropped. Existing lines keep their `styleId` and have no text.

### Why both a text column and the relation

The line already had `styleId`, a relation to the style master, and the form
offered a dropdown. That was the wrong shape for a purchase order: **material
is often bought before the style is set up**, so a dropdown of existing styles
cannot hold what the buyer needs to write.

Free text alone is no better — "SH-1042" and "SH1042" would sit side by side
and stop reconciling against production, which is why the relation was chosen
in the first place.

So both. `styleNo` is whatever was typed and is never dropped. `styleId` is set
only when that text matches a style's code exactly, and is cleared the moment
it stops matching — a stale link would quietly reconcile material against the
wrong garment. The style master's codes are offered in the cell as suggestions,
so the common case still produces a linked line.

Checked both ways on a real order: `LD-SH-2601` kept its text and linked to the
master; `NEW-STYLE-9099` kept its text with no link.

### What you have to do

Nothing to the database.

```bash
git pull
pnpm install
pnpm db:generate     # stop the API first — Windows locks the Prisma engine file
```

---

## 17 Sep 2026 — charges that are a percentage of the order

**Migration:** `20260917051240_charge_type_percent_of_value`
**Branch:** `feat/purchase`
**Status: already applied to the shared database.** Nobody needs to apply it.

### What changed

One column, `percentOfValue`, on `charge_types`. `DECIMAL(5,2)`, `NOT NULL
DEFAULT 0`. Additive: nothing renamed, nothing dropped, and every charge type
already on the system reads 0, which means "typed in by hand" — exactly what
they all did before.

### Why it is not the existing rate

`defaultGstRate` is the **tax charged on** a charge: 5% on dyeing, 18% on
freight. It is not how big the charge is, though the totals box printed it as
"Dyeing Charges @5%" and that reads like a share of the order.

Used as a share it is badly wrong. On a ₹500 order the five purchase charges
would have come to ₹290 — 58% of the order — because freight's 18% GST would
have been read as 18% of the goods. So the size of a charge needed a column of
its own.

### How it behaves

The charge box on a purchase order fills itself in at `percentOfValue` of the
gross total, and the buyer can type over it. Once typed, that box is left alone
for the rest of the order: a supplier quotes what a supplier quotes, and a
figure that snapped back every time a line changed would be unusable. A saved
order's charges are never recalculated — those figures are what was agreed.

Zero means the charge is always typed, which is right for anything quoted per
trip or per kilo rather than against the value of the goods. **Every charge
type is at 0 after this migration**, so nothing changes until the mill sets its
own percentages under Masters → Extra Charges.

### Reversed, same day — the column is now unused

The mill checked its old system: **only CGST and SGST are worked out there.**
Every charge — transport, freight, dyeing — is typed in by hand on each order,
and that is the behaviour it wants.

So the percentage is gone from the form and from Masters → Extra Charges, and
nothing reads `percentOfValue` any more. Every row is 0.

**The column is left in the database.** Dropping it would mean another
migration against the shared database to remove a column that holds nothing
and breaks nothing, and the schema comment says plainly that it is unused. Say
the word if you would rather it went.

### What you have to do

Nothing to the database.

```bash
git pull
pnpm install
pnpm db:generate     # stop the API first — Windows locks the Prisma engine file
```

---

## 17 Sep 2026 — a recycle bin for purchase orders

**Migration:** `20260917053005_purchase_order_recycle_bin`
**Branch:** `feat/purchase`
**Status: already applied to the shared database.** Nobody needs to apply it.

### What changed

Two nullable columns on `purchase_orders`, `deletedAt` and `deletedById`,
plus an index on `deletedAt`. Additive: nothing renamed, nothing dropped. Every
order already on the system has a NULL `deletedAt`, which means "not deleted".

### Why

Deleting a purchase order used to remove the row. Two real orders were lost
that way before this existed. Deleting now marks the row instead, and Settings
→ Recycle Bin lists what is marked, with Restore and Destroy beside each.

Restoring is one field going back to NULL. The lines, the charges and the
attachment files never went anywhere, so nothing has to be rebuilt from a
description of it — which is the whole reason for marking rather than copying
the order somewhere else first.

### The part that needed care

A soft delete is only as good as the filtering. A marked order that still turns
up in a report is worse than no bin at all, so every read was gone through:

- nine list-style reads (`findMany`, `count`, `findFirst`) across the orders
  list, the dashboard and the assistant now filter `deletedAt: null`
- eleven by-id lookups — open, print, edit, send, cancel, approve, reject,
  attachments, and both goods-receipt paths — treat a marked order as not found
- the bin's own route is the only one that reads the other way

Two of those lookups used `select` and did not fetch `deletedAt` at all; the
typecheck caught both.

Destroying from the bin is the only route left that really removes an order,
and it re-checks for goods receipts and bills first — an order can sit in the
bin while somebody who never opened it writes a receipt against the order.

### What you have to do

Nothing to the database.

```bash
git pull
pnpm install
pnpm db:generate     # stop the API first — Windows locks the Prisma engine file
```

---

## 17 Sep 2026 — a supplier can bill from more than one place

**Migration:** `20260917063658_supplier_addresses`
**Branch:** `feat/purchase`
**Status: already applied to the shared database.** Nobody needs to apply it.

### What changed

One new table, `supplier_addresses`, and one nullable column,
`purchase_orders.supplierAddress`. Additive: nothing renamed, nothing
dropped, no existing row rewritten.

Every supplier's existing address was then copied in as their default by a
separate script, so all **17 suppliers** have one and the Change list is never
empty. That was done in Node rather than in the SQL because ids here are cuids,
which Postgres cannot generate, and inventing a second id shape for these rows
alone would be a wart for as long as the table lasts.

### Why

The supplier master held exactly one address, so a supplier with a head office
and a works had the second one typed into a remark where nothing reconciled
against it. The purchase order form now has Change and Add new address, as the
mill's old system did, and an address added there is saved **on the supplier** —
so the next order to them offers it too.

### The two decisions worth knowing

**`stateCode` and `gstin` sit on the address, not only on the supplier.** A
business registers per place of business, and the state code decides the tax
split — so an order billed from another state changes what the supplier may
charge.

**The order stores the address as text, not as a link.** Correcting a typo in
the master, or retiring an address, must not change what an order already sent
to a supplier says. The printed sheet reads the order's own copy and falls back
to the master only for orders raised before this existed.

The default address is also mirrored onto the supplier's flat `address`,
`city`, `state`, `stateCode` and `pincode` columns. Those are read all over
the ERP — the printed order, the bill, the supplier list — and rewriting every
one of them to join an address table is a far larger change than this.

### What you have to do

Nothing to the database.

```bash
git pull
pnpm install
pnpm db:generate     # stop the API first — Windows locks the Prisma engine file
```
