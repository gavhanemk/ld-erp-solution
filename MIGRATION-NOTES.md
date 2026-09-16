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
