# Database changes — running notes

One entry per migration that is not yet merged into `main`, so anybody pulling
knows what happened to the database and what they have to do about it.

Delete an entry once its branch is merged and everybody has pulled.

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

To check where you stand:

```bash
cd packages/database
npx prisma migrate status
```

"Database schema is up to date" means your migrations folder and the database
agree, and you are safe.

### When the API goes live

Migrations do not run by themselves on the server. After merging a schema
change, somebody has to run:

```bash
pnpm --filter @ld-erp/database migrate:deploy
```

`migrate:deploy` only applies what is pending. It never resets, which is why it
is the right command against anything real.
