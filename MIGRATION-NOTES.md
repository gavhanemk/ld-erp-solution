# Database changes — running notes

One entry per migration that is not yet merged into `main`, so anybody pulling
knows what happened to the database and what they have to do about it.

Delete an entry once its branch is merged and everybody has pulled.

---

## 19 Sep 2026 — an item can be a style in one colour

**Migration:** `20260919120000_item_style_colour`
**Branch:** `feat/masters-item-style-colour`
**Status: already applied to the shared database.** Nobody needs to apply it.

### What changed

Two new columns on `items`:

| Column | Holds |
|---|---|
| `styleId` | Which style this item is, for a finished good |
| `color` | Which of that style's own colours |

A unique index on `(styleId, color)`, so two items can never be the same
style in the same colour, and a foreign key from `styleId` to `styles`, set
to `NULL` if the style is ever removed.

**Nothing existing was changed, renamed or deleted.** Both columns are
optional. No existing row was touched, so the migration could not have
broken anything already there.

### Why it was needed

A sales order, a manufacturing order and an invoice all need to find "this
style in this colour" as one sellable item. Until now `Item` had no link to
`Style` at all — only `BOM` did, and only through the style, not a colour.
The rule that the chosen colour must actually be one of the style's own
`colors[]` cannot live in the database — it needs a lookup — so it is
enforced in the API (`assertItemStyleColorValid` in
`apps/api/src/lib/itemStyleColor.ts`), not here.

### The four existing finished-goods items

They keep `styleId` and `color` blank, same as the four BOMs that kept a
blank colour before this. Guessing which of "Men's Formal Shirt", "Men's
Casual Check Shirt" and so on maps to which real style and colour would be
worse than leaving it for someone who knows the product line to set
deliberately. The next time one of them is opened and saved, the form will
ask for both.

### What you have to do

Nothing to the database. On your own machine, once the branch is merged:

```bash
git pull
pnpm install
pnpm db:generate     # stop the API first — Windows locks the Prisma engine file
```

### One thing worth knowing

While this migration was being written, the shared database had already
moved well ahead of `main` and even ahead of the BOM branch — 15 migrations
from `feat/purchase` and related GRN/purchase-order branches, three of them
applied that same day. None of them touch `items`, and `prisma migrate
deploy` only ever applies what is locally pending — it does not care what
else has already landed — so this went in cleanly regardless. If your
`prisma migrate status` shows migrations you don't recognise, that is very
likely this: check with the team before assuming it is drift you caused.

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
