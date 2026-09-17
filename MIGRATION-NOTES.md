# Database changes — running notes

One entry per migration that is not yet merged into `main`, so anybody pulling
knows what happened to the database and what they have to do about it.

Delete an entry once its branch is merged and everybody has pulled.

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
