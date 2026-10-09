# LD ERP Solution — Where the project stands

_Last updated: Fri 9 Oct 2026 — Sales orders, Phase 1 (branch `feat/sales-orders`)_

This file is the running record of what is built, what is not, and what to do
next. Read it first after any break.

---

## Sales orders — Phase 1 (Fri 9 Oct)

The first of four Sales phases (orders → dispatch and invoices → money in →
returns, quotations, reports). The plan, screen by screen, is the Claude Doc
"Sales Module: Screen Build Plan"; the business's answers behind it are in
docs/07 §6.

**Built:**

- **Order list** (`/sales/orders`), rebuilt on the purchase order list: server
  paging and search, four cards that filter (open, waiting for approval, due in
  7 days, overdue), filters, size rows that open per order, phone cards, export.
- **Order form** (`SalesOrderDialog`): own order or job work, customer panel
  with the tax split and a credit strip, one size box per size from the style's
  size run, typed rate with the customer's last rate shown, GST previewed from
  HSN. Save as draft or Send for approval. Edits a draft until it is sent.
- **Order detail** (`SalesOrderDetailDialog`): progress strip, lines, linked
  production orders, requisitions, challans and invoices, history.
- **Amend** (version kept in `sales_order_revisions`), **cancel** (before
  anything is made or sent, no open requisition) and **short-close**
  (approve rights; pending to zero).
- **Approval** through the dashboard and the assistant, one service: draft and
  sent only, not by whoever raised it (Admin excepted), and a customer over the
  credit limit or blacklisted is released with a reason — not blocked.
- **Order confirmation print** (`/print/sales-order/[id]`), heading from
  Settings → Documents → Sales Order. Brokerage is never printed.
- Every sales route checks a sales permission. The store's order pickers read
  `/sales/orders/options` instead. A Brands master page.
- GST is worked out on the server from each item's HSN code at the price per
  piece; HSN is copied onto each line.
- The mobile order screen showed every line as 0 pcs at ₹0.00 (it read `qty` and
  `rate`); fixed, with the size run.

**Migration:** `20261009120000_sales_order_lifecycle`, applied to the shared
database on 9 Oct — see MIGRATION-NOTES.md.

**Data to fix before real use:**

- The four finished-goods items have no style linked, so the form shows one
  pieces box per line instead of size boxes. Link each to its style and colour.
- The HSN master has 6203 at a flat 5% and no 6205; garments above a price per
  piece carry a higher rate. Enter the threshold and the higher rate on those
  codes once the CA confirms them.
- Non-admin users need sales permissions: make a Sales role in Settings.

**Not in Phase 1:** attachments on an order (needs a new table), deleting a
draft (a deleted draft would leave a gap in the numbers — cancel it instead).

---

## BOM costing and pricing (Mon 28 Sep)

A BOM now carries what one garment costs to make and what it sells for, not
just its material. The form has three steps, and each step saves before moving on:
**1 Materials → 2 Costing → 3 Pricing.**

**How it works:**

- **Materials** is the form as it was.
  - A "supplied by customer" tick per line was added on 28 Sep and removed the
    same day, on request.
  - Its database column (`bom_lines.customerSupplied`) was already applied, so it
    stays. It is unused and always false.
  - A cut-make-trim BOM therefore costs the customer's fabric like any other line.
- **Costing** holds two tables:
  - **Labour:** one row per job, in ₹ per piece, with an optional department.
    **Fill from routing** copies in a routing's rated steps as a starting point.
    It is a copy, not a link.
  - **Overheads:** each one either ₹ per piece or a % of material + labour.
- **Cost per piece** = material + labour + overhead, rounded to the paisa at
  every step.
- **Pricing:** type a **margin** and the price is worked out, or type the
  **price** and the margin is worked back.
  - The margin is a share of the selling price: at 20%, price = cost ÷ 0.80.
  - The price is rounded **up** to the rupee, before GST. The GST figure shown
    uses the default rate in Settings.
  - A price below cost is allowed, with a warning. A price below half the cost is
    refused as a probable typo.

**Rules:**

- **Who sees costing:** only people with **masters: approve**, which today is
  Admin and MD. The API leaves labour, overhead, cost, margin and price out of
  every answer for anyone else, who still get the materials step exactly as
  before. Giving a merchandiser that right is a role setting under Settings.
- **Approve locks the costing, not the price.** Materials and costing are frozen
  with the BOM. The price stays editable after approval, through
  `PATCH /masters/bom/:id/price`, and every change goes to the audit log.
- **A draft's price follows its margin.** If the cost of a draft changes, its
  price is worked out again from the saved margin.
- **Copy** carries over the costing rows, the margin and the price, but not who
  priced it.
- **The AI assistant is unchanged:** it still reports material cost only, so it
  cannot quote a price to someone who may not see one.

**The BOM list:**

- Approvers see cost and price on each row.
- The expanded view shows Material + Labour + Overhead = Cost per piece, then the
  selling price, margin and profit.
- The old "Labour — making steps" table, which showed demo routing rates, is
  replaced by the BOM's own labour and overhead rows.

**Database:** migration `20260928100000_bom_costing_and_pricing`, applied to the
shared database on 28 Sep. See `MIGRATION-NOTES.md`.

**Tested:**

- Type-check passes for both apps, and `next build` passes.
- All three steps were rendered with sample data in both themes, and as a user
  without approve rights.
- The save requests were checked for a draft, an approved BOM and a non-approver.
- The migration was dry-run in a rolled-back transaction, then applied, and its
  results were read back.
- **Not yet tried by hand against the live API.**

**Not in this step:**

- actual cost after production (Phase 5)
- a price per buyer, or prices filled into sales orders
- broker commission
- a price-history screen (the audit log holds it)

---

## BOM form — redesigned, and trimmed to what is used (Sat 26 Sep)

Laid out to a reference design supplied on 26 Sep, and cut down to the fields
something actually reads today.

**On the form now:**

- Style and Colour.
- Per line:
  - Item, with an icon for its category.
  - Process.
  - Qty / pc, with the unit shown inside the box.
  - Rate in ₹; blank means the standard rate.
  - Cost.
  - A **+** beside Delete, which adds a new line directly below that one.
- Notes.

**Taken off the form, and why:**

- **Version.** A new BOM starts at 1.0, and later versions still come from Copy
  on the BOM list. An open BOM still shows its version in the header.
- **Wastage %.** Removed on request: consumption is now typed with the wastage
  already in it. **This reverses the 17 Sep decision below that "wastage stays
  as its own column".** The column stays in the database, and a line saved with
  a wastage keeps it. The form sends it back unchanged and shows "+5%" in the
  cost box, so the cost still adds up on screen.
- **Part, Sized on, quantities by size, Routing, Active.** Nothing reads these
  yet. On 26 Sep nothing outside the BOM list used them, and the MO cannot be
  created at all. Existing values are kept on save, not wiped. Offering and
  retiring a BOM is done from the BOM list.
- **Effective.** It only ever showed quantity plus wastage.

**Kept on purpose: Process.** Roadmap step 1.2 raises one store requisition per
department from it. Every BOM saved without it would need reopening then.

**Fixed along the way:**

- **Saving an approved BOM always failed.** The form sent the locked lines, and
  the API refused them with a 409. It now sends only the notes, and the button
  says "Save notes".
- **Clearer message when a style and colour already has a BOM.** When the form
  sends no version, the API used to say "give this one a different version",
  which the form can no longer do. It now says to copy the existing BOM from the
  list.
- **Routing hint on the BOM list.** It no longer tells people to "edit this BOM
  to link a routing".

**Not changed:**

- The database.
- The BOM list's expanded view. It still shows wastage, effective quantity and
  quantities by size for BOMs that have them.
- The copy dialog, which still takes a version.

**Tested:**

- Type-check passes for both apps.
- Rendered with sample data in both themes.
- The save request was checked for a draft BOM and for an approved one.
- **Not yet tried against the shared database.**

---

## An item can be a style in one colour (Sat 19 Sep)

A finished-good item now carries `styleId` and `color`: required when
`type` is `FINISHED_GOOD`, forbidden otherwise, and the colour must be one
of that style's own `colors[]`. This is the piece the BOM work identified
as needed before Production can build manufacturing orders — an MO, a sales
order or an invoice can now find "this style in this colour" as one item.

**What changed:**

- **`Item.styleId` / `Item.color`**, both optional at the database level,
  unique together so two items can never be the same style in the same
  colour. Migration `20260919120000_item_style_colour`, already applied to
  the shared database.
- **The colour rule can't live in the database** — "one of this style's own
  colours" needs a lookup — so it's enforced in the API, in one place:
  `assertItemStyleColorValid` in `apps/api/src/lib/itemStyleColor.ts`,
  shared by the HTTP routes and the AI assistant's `create_item` tool.
- **`/items` gets two hand-written routes** (POST, PATCH/:id) ahead of its
  `crudRouter` mount, since `crudRouter` has no hook a database-backed check
  could run from. GET and DELETE are untouched.
- **`MasterFormDialog` gains two small, additive capabilities** every master
  screen can use from here on: `showIf` (a field only shown, and only
  required, once another field's value says it applies) and
  `optionsFromField` (a dropdown whose choices come from a property on
  whatever record another field currently points at). The Items screen uses
  both — Style only shows for a Finished Good, Colour only offers that
  style's own list.
- **A bug fix, found while wiring the AI assistant through this**:
  `create_item` already resolved and sent a `taxRateId`, but
  `createItemSchema` had no such field — Zod silently strips unrecognised
  keys, so every item the assistant created with a GST rate specified was
  quietly losing it. Fixed alongside adding the field properly.

**The four items seeded before this stay blank** on style and colour — the
same call the BOM migration made for blank-colour BOMs. Guessing which of
"Men's Formal Shirt", "Men's Casual Check Shirt" and so on maps to which
real style is worse than leaving it for someone who knows the product line.
The next time one is opened and saved, the form will ask for both.

**Verified:** both apps typecheck clean; the web build compiles (fails only
on the pre-existing `/404` prerender bug, confirmed unrelated — nothing in
this change touches routing or error pages); 8 smoke-test cases run against
the real database covering every branch of the validation, then cleaned up.
**Not yet tested on screen** — that's the next step before this merges.

**Deliberately not touched here:** `SalesOrderLine.styleCode`/`color` and
`MOLine.color` still duplicate what `Item` now owns properly, as free text.
Left as a follow-up for whenever Sales or Production is next worked on —
noted directly on those two schema fields as doc comments.

---

## Bill of Materials — per colour, with a department per line (Thu 17 Sep)

Checked against a manufacturing order exported from the old ERP (MO00089). What
it showed, and what the production team, accounts and the old ERP's users decided:

- **One BOM per colour, quantities by size inside it.** A white shirt and a dusty
  blue one take different cloth. `BOM.color`; the unique key is now style +
  colour + version. Approving retires the old approved BOM of the **same colour
  only**. Copying is how a colour's BOM is made — copy White to Dusty Blue and
  change the fabric line.
- **A department on each BOM line.** The old ERP ties every component to a
  process. A material requisition is raised by one department, so this is what
  lets the Production module ask the store for materials stage by stage.
- **Wastage stays as it is** — its own column on each line.
- The assistant now reports material cost **per colour**; taking the first
  approved BOM would have quoted one colour's cost as the whole style's.

**The migration was applied on 17 Sep, during the team's hold on migrations**, so
this could be tested — a deliberate call. `main` is one more migration behind the
database as a result. See `MIGRATION-NOTES.md`.

The four existing BOMs have no colour, because every one belongs to a style in two
or three colours and guessing is worse than a blank. They show **Colour not set**.

**Decided (17 Sep): a sellable shirt is one item per style + colour, with sizes
recorded on the order** — the way the old ERP's MO00089 works: one item, S to 3XL
underneath it. So style + colour is the key that joins everything: the finished-
goods item, the sales order line, the manufacturing order line (which already
carries style and colour) and the BOM (which now does too).

What that means for the next branch, which gives finished-goods items a style and
a colour so an order can find its BOM:
- The four finished-goods items in the database (`FG-SHRT-001` and friends) are
  generic — no colour, no style. Like the four colourless BOMs, they will need
  splitting per colour rather than guessing.
- Sales order lines and manufacturing order lines are both empty today, so no saved
  order has to change shape.
- **Still to decide, with whoever owns Inventory, before packed goods go into
  stock:** `stock_ledger` has no size. With one item per colour, finished stock
  would say "LD-SH-2601 White: 848" with no way to tell how many are XL. That is an
  Inventory change, not a masters one, and it is not needed until packing.

---

## Bill of Materials — extended (Wed 16 Sep) — READ THE MIGRATION NOTE

The BOM module already existed. This round closed the gaps that stopped it
being usable for a real garment costing.

**What is new**

- **Consumption by size.** `BOMLineSize` holds a per-size quantity as a sparse
  override: a size with no row of its own consumes what the line consumes, so a
  style with no size run behaves exactly as it did before. The base size is a
  field now (`BOM.baseSizeId`) instead of the words "size 40 basis" sitting in
  the notes where nothing could read them.
- **A routing link.** `BOM.routingId` points at the Routing master rather than
  repeating its steps, and `BOM.labourCost` is the sum of rate per piece across
  them. The screen shows Material, Labour and Total — it used to say
  "per piece" and mean material only, which is what a merchandiser would have
  quoted a buyer.
- **A status lifecycle.** DRAFT to APPROVED to OBSOLETE. Approving freezes the
  components and retires any other approved BOM for that style in the same
  transaction, so "which version is current" finally has an answer. An approved
  BOM cannot be edited, so `POST /masters/bom/:id/copy` ships alongside it —
  without a copy action people would simply edit the approved one.

**Bugs found and fixed**

- The assistant quoted a material cost from `boms[0]` on a query with no
  ordering, so a style with two live versions answered differently on different
  days. It reads the approved BOM now.
- `GET /masters/bom` ignored `q`, `sort`, `order` and `active`. Because DELETE
  only sets `isActive = false`, a retired BOM never left the list — retiring one
  looked like it had done nothing.
- A repeated version showed the clerk `styleId,version already exists`.
- Line cost was worked out from the unrounded quantity while the rounded one was
  displayed, so Effective times Rate did not equal Cost on screen.
- An item with no standard rate was silently costed at zero. Saving still works
  — a BOM is often costed before anyone has quoted — but the response now names
  the components, and approving is refused outright.
- The edit dialog loaded one page of active items and priced from it, so a
  component deactivated since would show a blank dropdown and ₹0.00 while the
  server held the real cost. A clerk would have deleted the row.
- The BOM screen had no way to deactivate a BOM at all.

**The migration has NOT been run**

The schema is changed and `pnpm db:generate` is clean, but `prisma migrate dev`
needs `DATABASE_URL` and `DIRECT_URL`, which the machine this was written on did
not have. **Until it is run the code does not match the database.**

Generate it with `--create-only` and append the status backfill before applying.
`status` defaults to DRAFT, which would otherwise mark every existing BOM a
draft that nothing can cost against:

```sql
-- Only where the answer is not ambiguous. A style with two active BOMs would
-- get two approved ones, which is the very thing this work removes.
update ld_erp.bom b set status = 'APPROVED'
where b."isActive"
  and (select count(*) from ld_erp.bom x
       where x."styleId" = b."styleId" and x."isActive") = 1;
```

Then list the ambiguous ones so somebody can choose:

```sql
select s.code, count(b.id) from ld_erp.styles s
join ld_erp.bom b on b."styleId" = s.id and b."isActive"
group by s.code having count(b.id) > 1;
```

**Still open**

- **Re-pricing a BOM after a rate change is still not possible.** The rate is
  resolved and stored on the first write, so the item master is read once and
  never again. Fixing it needs a column that tells a borrowed rate from a typed
  one, and that is another schema change.
- BOM still does not reach production. `POST /inventory/requisitions` is live and
  working, so BOM to material requisition is the natural next branch. BOM to
  manufacturing order is blocked until an MO can be created at all — every
  handler in `production.routes.ts` is a GET.
- `@@unique([bomId, componentItemId])` was considered and deliberately left out:
  the same self fabric legitimately appears twice at two wastages, body and
  collar. `BOMLine.component` labels the part instead, and the constraint would
  have failed on any live data that already has a repeat.
- `next build` fails prerendering `/404` with a React `useRef` error. It fails
  the same way on a clean checkout, so it is not from this work — but somebody
  should chase it, because it means the web app cannot be built for production.

---

## The ERP runs

Verified end to end on 22 Aug 2026 against the live database: login issues a
token carrying all 78 permissions, master reads return the seeded data, a create
is written and audited, and an invalid GSTIN is rejected.

**To start it:** double-click **START ERP.bat**. It launches the API and the web
app in their own windows, waits until both actually answer, then opens the
browser. Closing those two windows stops the ERP.

Sign in with:
- `admin@ldcottonmills.com` / `Admin@123`
- `md@ldcottonmills.com` / `MD@12345`

**If the database password ever needs changing** (a Supabase reset, or moving to
another project), run `set-db-password.ps1`. It asks for the password without
echoing it, URL-encodes it, writes both `.env` files, and proves the connection
before finishing.

Copy the host from the Supabase dashboard rather than guessing — Supabase
assigns either `aws-0-*` or `aws-1-*` per project, and the wrong one will not
connect.

---

## Deployment (checked Thu 17 Sep 2026)

| Piece | Where | Address |
|---|---|---|
| Code | GitHub, **private** | github.com/gavhanemk/ld-erp-solution |
| Web app | Vercel, auto-deploys from `main` | https://ld-erp.vercel.app |
| API | Render free plan, auto-deploys from `main` | https://ld-erp-api.onrender.com |
| Database | Supabase, already live | project `cpogaadkcefpeanxbqkb` |

**All three are live.** Checked on 17 Sep: the website answers, and
`/health` on the API answers `"database":"ok"`. This table said the API was
"not created yet" until today, which was two weeks out of date and read as
"deploying is pointless" — it is not. Merging `main` rebuilds both halves.

The first request of the day takes about 35 seconds: the free plan puts the
API to sleep after 15 minutes and that is it waking up. Measured, not
estimated. Nothing is broken when it happens, but it will look broken to
somebody signing in, so move to the paid plan before the mill depends on it.

The API cannot go on Vercel: it is a long-running Express process with
Socket.io and Vercel only runs code in short bursts. `render.yaml` is a
blueprint — in Render, New → Blueprint, pick the repo, and it reads the file.
Two values have to be pasted in by hand, `DATABASE_URL` and `DIRECT_URL`, both
in `apps/api/.env`. The JWT secrets are generated by Render itself rather than
copied from the development machine.

This is already done and does not need doing again — the live build points at
`https://ld-erp-api.onrender.com/api`. It is only needed if the API ever moves:

    npx vercel env add NEXT_PUBLIC_API_URL production   # https://<render-url>/api
    npx vercel --prod

**Next.js was upgraded 15.0.3 → 15.5.23** during the deploy. Vercel blocked the
first attempt outright because 15.0.3 carries the middleware authorisation
bypass (CVE-2025-29927). Do not pin it back.

---

## Goods receipts, and what comes after a purchase order (Fri 18 Sep 2026)

The mill's old Absolute ERP was logged into and read end to end, read-only, to
settle what the purchase module actually does after an order is raised. The
survey and the reasoning are written up as an artifact, **After the Purchase
Order**; what follows is what it changed here.

### The chain, as the old system has it

```
Indent —> Provisional PO (enquiry) —> Supplier rates —> PO
  —> GRN —> QC —> Bill from GRN —> Payment —> Debit note
```

Traced on a real order to be sure of the links, not inferred from menu names:
**PO-0514** (₹6,279) —> **GRN-0480** (challan 1872-1887) —> supplier bill
**777/2627**. The bill's reference is the *receipt*, not the order.

### There are three GRNs in that system, and only one is ours

| GRN type | Against | Goods arrive from | Module |
|---|---|---|---|
| **Purchase Order GRN** | A purchase order | A supplier — goods we bought | **Purchase. Ours.** |
| Job Work GRN | A job-work order | A job worker — our material back | MO Job work |
| GRN JW Customer | A sales order | A customer — their material in | Customer GRN |

The other two belong to modules that do not exist here yet. Building them now
would mean guessing at production and sales at the same time.

### Four decisions, his, on 18 Sep

1. **Receive and inspect on one screen.** The old ERP splits them — a store
   keeper records the arrival, then the receipt waits in *Pending GRN for QC*
   for somebody else to enter approve and reject quantities. At this mill the
   same person does both, so a second screen would be a queue with one name in
   it. Our GRN line already carried ordered / received / rejected / accepted
   together, so nothing had to be rebuilt to honour this.
2. **Keep the gate entry and challan fields.** All thirteen.
3. **One bill covers several receipts, from day one.**
4. **Roll barcodes later.** The old system prints barcode labels for received
   fabric rolls. Not started.

### What was built

- **Fourteen delivery columns on `grn`** — migration
  `20260918064500_grn_delivery_details`, hand-written and applied additively.
  See [MIGRATION-NOTES.md](MIGRATION-NOTES.md); the generated version of it
  wanted to drop the other team's BOM tables.
- **The receiving screen** now has a *Delivery paperwork* panel (open by
  default, foldable) with gate entry, challan, the supplier's bill and invoice,
  packages, driver, form no, client, ordered by and reference — plus a time
  field beside the date, because two deliveries from one supplier on one day
  are told apart by nothing else. All optional: somebody at the gate with a
  lorry waiting must never be stopped by a blank driver name.
- **One order line can be split across stores.** A `+` on each row, as the old
  grid's Location/Qty repeater does it. 800kg going 500 to the godown and 300
  to the works is one receipt, not two.
- **The Goods Receipt Note prints**, at `/print/goods-receipt/[id]`, on the
  purchase order's sheet — same navy, same letterhead. Three header blocks,
  the items, the money, and Prepared By / Inspected By / Authorized By.
- **A bill can now gather several receipts.** The picker adds rather than
  replaces, refuses a receipt from another supplier or one already on the bill,
  and drops the order link once the bill spans two orders — the header cannot
  honestly name one then.

### The two traps this work walked into

- **The over-receipt check had to learn to add up.** It compared each row
  against what was due. Once a line could appear twice for two stores, two rows
  of 500 would each pass against an order for 800. It now sums the receipt's
  own rows per order line first. Verified: two rows of 10 against 5 still due
  is refused, and the message says 20.
- **A second padded wrapper costs a printed page.** The `(print)` layout
  already puts every sheet on `.print-surface`, whose padding is reset for the
  printer. The note added its own padded wrapper inside it, whose inline
  padding cannot be reset — and a two-line receipt came out on two sheets.
  Found by counting `/Type /Page` in the PDF, which is the only test that
  counts. One page now.

### Checked end to end against the live database

PO-0001 —> **GRN-2627-0001** (60 to Trims & Accessories with 5 rejected, 40 to
Fabric Godown) —> **GRN-2627-0002** (the last 5) —> the order reads COMPLETED
—> one bill **PB-2627-0001** pulling all three lines from both receipts, ₹62
—> billing them a second time refused with *"only 0 is left to bill on
GRN-2627-0001"*.

**Those documents are real and are still on the system.** They were made to
test the chain, on his test order. Cancelling the bill and the two receipts
reverses the stock if he would rather they went.

### Still not built

The QC split (deliberately — see decision 1), roll barcodes, and the whole of
Provisional PO / supplier rate comparison, which sits *before* the order rather
than after it.

## Where we left off (Thu 17 Sep 2026) — READ THIS FIRST

The purchase module is built: orders, goods receipt, bills with a three-way
match, file attachments, a printed order sheet, a recycle bin, and the
supplier's own addresses. It is all on the `feat/purchase` branch, which is
**now open as a pull request into `main`** — 45 commits. It needs one other
person to pull it, run it and approve it, and merging is what deploys the web
app. Nothing of it is on the live site until then.

**What went in on 17 Sep**, all on top of the form rebuild:
- Delete a purchase order into **Settings → Recycle bin**, and restore it.
  Cancel was the only way out before
- A supplier's addresses live on the supplier master; the order picks one,
  and adding or correcting one from the order form saves it on the supplier
- The last rate an item was bought at, shown under the Rate cell, with a
  panel listing every previous purchase of it
- Terms and conditions pre-fill from Settings → Documents
- The form's own layout: white panels on the grey page instead of grey on
  grey, one Save at the top instead of three, the supplier's details as an
  aligned grid instead of a ragged column, smaller labels

**Then, later the same day** — the printed sheet and the screens it is reached
from:

- **The printed purchase order was rebuilt** to the layout he supplied: navy
  and a pale navy tint, the logo on the letterhead (it was in Settings all
  along and the sheet never printed it), a "To," block set out the way the
  mill's old sheet sets it out, and the supplier's own fields — Kind
  Attention, TIN No, Colour, Style No. — back on the paper. Style No. was the
  one that mattered: the order has carried it since the form gained the field
  and the sheet never showed it.
- **Three bugs the sheet had all along**, found by printing it to PDF rather
  than looking at it:
  1. Every order printed on **two** pages while the footer said one. The
     toolbar above the sheet is marked `.no-print`, and that class is defined
     inside `PrintSheet` — which this page does not use. So the toolbar was
     being printed, pushing the sheet down a page.
  2. `@page { margin: 0 }` was missing for the same reason, so Chrome applied
     its own 10mm margin to a 297mm block.
  3. Nothing set `print-color-adjust`, so every filled band — the heading
     strips, the total, the footer — would have printed white. White text on
     white paper for the total.
- **The page-break numbers were fiction.** They were 9 and 13, calculated
  from an assumed row height, and this file said in as many words that nobody
  had printed a long order to check. They are now a pixel budget worked out
  from four measured heights, because the lines and the charge rows are
  different heights and compete for the same page. Verified by PDF page count
  at 1, 2, 3, 4, 13, 14, 22 and 23 lines and with charges on and off.
- **The sheet was setting in the wrong typeface.** `next/font` publishes Inter
  under a generated family name and hands it over as `--font-inter`; the sheet
  asked for the literal `Inter`, which matches nothing. It had been rendering
  in whatever the system offered. Figures also came off the monospace face —
  a code font is most of what made a purchase order read like a terminal.
  **`tailwind.config.js` has the same literal in its `sans` stack, so every
  screen in the ERP is probably doing this too.** One line to fix and it
  changes the look of the whole app, so it was left alone.
- **Charges print only when they are entered on the order.** Printing a row
  for every charge in the master was tried and reversed: five charges are
  flagged for purchases, three of them near-duplicates, and four rows of 0.00
  are four questions a supplier does not need to ask. Worth tidying that
  master — see "Decisions he has given".
- **The purchase screens work on a phone.** Below `xl` the three lists stop
  being tables and become one block per row; a ten-column table cannot be
  made to fit 390px and dragging it sideways put the buttons off whichever
  edge you were not looking at. At 1366px — the commonest laptop — the orders
  table fits with nothing hidden, where before its buttons sat off-screen.
- **The sidebar is a drawer below 1024px**, with a hamburger in the top bar.
  This is the one change outside the purchase module and he agreed to it: a
  260px sidebar on a 390px screen left 130px for the page, so no amount of
  work inside purchase could have made a phone usable. It touches
  `(dashboard)/layout.tsx`, `Sidebar.tsx` and `TopBar.tsx`, so **it wants
  splitting into its own branch before this merges** — one branch, one job.

**A measuring note, because it cost an hour.** Headless Chrome has a minimum
window of about 500px. Screenshots taken at `--window-size=390` are a 500px
page cropped to 390, which looks exactly like a layout that overflows — and I
reported a shell overflow bug on that basis that did not exist. To render a
true phone width, put the page in a 390px iframe inside a wider window —
or drive Chrome over the DevTools protocol and set
`Emulation.setDeviceMetricsOverride`, which gives a real 390px viewport and,
unlike a screenshot, can click things. Node 24 has a global `WebSocket`, so
that needs no package: launch with `--remote-debugging-port`, read the target
from `/json/list`, and drive it with `Runtime.evaluate` and
`Page.captureScreenshot`. Watch out that Chrome's `innerText` applies
`text-transform`, so a section heading styled in small capitals is `TOTALS`
and never `Totals`.

**Two things the form deliberately does not do**, both because he checked the
old ERP and said so:
- **Charges are still not calculated, but they can be worked out on request.**
  Nothing about a charge fills itself in. Since 18 Sep every charge row — and
  the Other charges box — carries a small `%` button that opens a strip
  underneath it reading `[5] % of gross total ₹55.00 → ₹2.75 [Use]`. It shows
  its working, it is typed over freely, and it writes the figure into the box
  only when Use is pressed. What is saved is a plain amount; no percentage is
  stored on the order, because the supplier agreed to a number and an order
  that recalculated itself later would stop matching their copy.

  The box opens on `ChargeType.percentOfValue` when the mill has set one
  (Masters → Charges → "Usual % of order"), and otherwise on the rate printed
  on the row. Those two are different things and it is worth keeping straight:
  `defaultGstRate` is the **tax on** the charge, `percentOfValue` is **how big
  the charge usually is**. They are frequently the same number, which is
  exactly why they get confused. Transport Charges is the only row with a
  usual size set (5%) — the rest fall back to their GST rate, which is at
  least the number in front of the buyer.

  `percentOfValue` was dead from 17 to 18 Sep. The migration
  `20260917051240_charge_type_percent_of_value` had already added the column,
  so wiring it up needed **no migration** — the API schema, the master form
  and the helper were the whole job.
- **The rate does not pre-fill** from the item master. A rate nobody typed is
  a rate nobody checked. The GST rate still pre-fills: that is a fact about
  the item, not a negotiated price

**The one thing to check on paper.** The printed purchase order paginates
itself rather than letting the browser break it, because a browser will not
give you a page number and "Page 1 of 2" has to be true. Nine lines fit one
sheet and thirteen go on the first of two. Those two numbers were calculated
from the row height, not measured on paper, and they are the two to nudge:
`FITS_ON_ONE_SHEET` and `ROWS_ON_FIRST_OF_TWO` at the top of
`apps/web/src/app/(print)/print/purchase-order/[id]/page.tsx`. Print a long
order and see where it breaks.

Column widths on that sheet are plain percentages in the `COLS` array in the
same file. **This file used to send people to `DocumentTable` in
`PrintSheet.tsx` for them — that is no longer true.** The purchase order sheet
draws its own table now and only borrows `PrintToolbar` and `money` from
`PrintSheet`. The purchase *bill* sheet still uses `PrintSheet` proper.

**One open decision, his:** `pnpm reset` maps to `prisma migrate reset
--force`. `--force` means no confirmation at all, so one mistyped word wipes
the ERP. Worth a guard, but it is a shared script.

**Not ours, and now accounted for.** The shared database has 19 migrations
applied; this repo has 17 folders, three of them new on this branch. The two
we do not have are both BOM work from another machine:

| Missing here | Sitting on |
|---|---|
| `20260916104500_bom_size_routing_and_status` | `origin/feat/masters-bom-size-routing-status` |
| `20260917100000_bom_colour_and_process` | `origin/feat/masters-bom-colour-and-process` |

Until those two branches merge, **nobody should run `pnpm db:migrate`**: our
schema has no BOM models in it, so Prisma reads their tables as unexplained
and offers to drop them. That offer is the "drift / reset" prompt, and the
answer is always no. It deletes everything in the ERP.

**Our own three migrations need nothing done to them.** They were written by
hand and applied additively with `prisma db execute`, then marked applied with
`prisma migrate resolve` — row counts taken before and after each one. So
merging this branch does not need `migrate:deploy`, because there is one
database and the changes are already in it. See
[MIGRATION-NOTES.md](MIGRATION-NOTES.md).

**Two print bugs from 24 Aug, both still worth knowing:**
- The sidebar and top bar were on the print page and would have printed. Print
  pages now live in their own route group with no app shell.
- `overflow-wrap: anywhere` let a column shrink to one character, so the
  supplier address printed vertically, one letter per line. Never use
  `anywhere` in a table; `break-word` does not count towards a column's
  minimum.

**How he works:** short, plain sentences. No jargon, no file paths, no rule
numbers unless he asks. Answer the question first, then the detail. He is not
technical and will say "didn't understand" to a long technical answer — that is
a signal to say it again shorter, not to add more detail.

**Live demo data he entered** — a supplier (LD Silk Mills), one item (LIO LINEN)
and PO-2627-0001 for ₹1,54,350. The HSN and some codes are deliberately not
real; he said not to worry about them, they are for testing. There are now 43
items with categories, added as dummy data for testing the pickers.

**Decisions he has given:**
- No data comes across from Absolute ERP. Whatever is there stays there. Do not
  offer to migrate it again.
- Garment GST is 5%.
- LD Silk Mills is his own second company with its own GSTIN — a supplier here,
  never a second company inside one database.
- Users and roles can be reconfigured later; not a priority.
- **Nothing is committed until he says so**, and never to `main`. Work goes on
  a branch and waits.
- An item code is an item's identity, not a search box. Typing a full code
  resolves that item; it does not filter a list.
- **Charges are typed in per order, and print only when typed.** The charge
  master has five kinds flagged for purchases and three look like duplicates
  — "Dyeing Charges" beside "Dyeing Charges (Processing)", "Freight / Courier"
  beside "Freight / Courier (Transporter)". Not tidied, because unticking a
  charge also stops a buyer putting it on an order and both are real things a
  mill pays for. His call, in Masters → Charges.

**Next:** supplier payments is the last 501 in the purchase module, so a bill
can be raised but not paid. After that, sales orders have no form either.

---

## Earlier on Mon 24 Aug

After the Settings module, Mahesh asked for the data model itself to be made
logically correct — "everything should be connected, wired up". An audit of all
58 models found the schema relationally sound but carrying free-text columns
where relations belonged, and 23 models with no way to reach them at all.

**Decisions he gave us:**
- **LD Silk Mills is his own second company**, registered under a separate
  GSTIN, supplying fabric to LD Cotton Mills. It is therefore an ordinary
  supplier in these books, flagged `isGroupCompany` so intercompany turnover can
  be excluded from group figures. It does **not** become a second company inside
  one database — separate GSTIN means separate books and separate returns.
- **Garment GST is 5%.** The seed now defaults to it. Still worth the CA's
  written confirmation before any rate is treated as settled.
- Users and roles in Absolute can be reconfigured later; not a priority now.

**What the correctness pass changed** (see the commit for the full list):
- 18 new tables, 11 new enums replacing free-text `status` columns
- `ProductionEntry.department`, `MaterialRequisition.department` and
  `DeliveryChallanLine.uom` became real foreign keys
- Routing, Workstation, Size, Broker and ChargeType masters now exist
- Invoices and bills gained line items, charges, discount and round-off; credit
  and debit notes exist for the first time
- GST state codes on company, customer, supplier and broker
- Stock can be marked as belonging to a customer rather than to us

**Two live defects were fixed and proven:**
1. Every sales order was taxed as IGST — including local ones — because the code
   compared a state *name* ("Maharashtra") against `COMPANY_STATE_CODE=GJ`. Now
   both sides carry a two-digit GST state code and the split is correct.
2. Sales order numbers came from `Math.random()`, ignoring the number series and
   able to collide. They now come from the counter, atomically.

**Pick up here next — the API and UI wiring:**

1. ~~13 endpoints returning an empty array.~~ **Done.** Inventory is built for
   real (see below). `accounts` and `hr` now answer 501 and say so on screen,
   which is what docs/03-build-rules.md asks for.
2. ~~Goods receipt, still a 501.~~ **Done.** Built, with a screen.
3. ~~No screens yet for the new masters: workstations, brokers, routings, size
   groups, charge types.~~ **Done.** All five exist, plus item categories.
4. Three models still have no route and no screen at all: `BankAccount`,
   `SalaryStructure`, `Voucher`.
5. Sales invoice creation. Purchase orders and purchase bills both print;
   nothing on the sales side does yet.
6. Supplier payments — the last 501 in `purchase.routes.ts`. A bill can be
   raised and matched, but not paid.

Run `node <scratch>/audit.js` (kept in the session scratchpad) to re-check which
models are reachable; it accounts for the CRUD factory's dynamic delegate and
for child tables written through a parent.

---

## The Settings module (earlier the same day)

The Settings module is built and tested. It was designed against the real
Absolute ERP — signed into and read page by page — rather than guessed at.

**What Absolute showed.** Its Settings holds 24 sections. Eight are ISO
compliance modules (9001, 14001, 22000, 45001, 20000-1, 27001, 50001, 13485)
that LD Cotton Mills has never opened. Setup Preferences asks around forty
yes/no questions, and most belong to a construction and projects business —
cables and installation budgets, project codes, technical service, milestone
headings. Perhaps six of those questions mean anything to a garment unit, and
they sit mixed in with the rest. That is why Settings feels vast: it is every
industry's settings at once.

**What was built instead.** Four tabs, holding nothing that does not apply:

- **Company** — details and GSTIN, financial year, document numbering, GST rates
- **People** — users, roles, and one permission grid
- **Preferences** — five settings, each wired to something real
- **System** — connections, your own password, the activity trail

**Pick up here next:**

1. Ask what Mahesh noted down while using the ERP. That list should drive the
   next round, not a guess at what to build.
2. Rename the seeded "Admin User" to his own name and add the real people —
   Settings → People can do that now.
3. The natural next build is **entering a real sales order end to end**. The
   list screen reads live data but there is no form to create one, so nothing
   flows through the system yet. That unlocks the dashboard figures, approvals
   and manufacturing orders actually doing something.

**Not yet discussed with him:** GEMINI_API_KEY is still not set, so the AI
assistant cannot answer anything. Settings → System now says so plainly rather
than leaving it a mystery. It still needs a decision on whose API key and who
pays for it.

---

## What happened before this file existed

The Gemini/Antigravity agent wrote a first pass of the project, but its work
lived only inside the IDE's scratch workspace at
`C:\Users\Admin\.gemini\antigravity-ide\scratch\LD ERP Solution` and was never
applied to the real folder, which held empty directories and nothing else.
Gemini then ran out of its plan quota.

All 56 of those files were recovered here. None of it had ever been compiled:
the Prisma schema had 37 validation errors, TypeScript had 30, and the web app
would not build. That is all fixed.

An earlier, abandoned attempt sits at `...\scratch\ld-erp`. Its schema is
identical, but its `ai.service.ts` has 4 extra AI tools worth porting
(`approve_document`, `send_payment_reminder`, `get_purchase_orders`,
`generate_report`).

---

## Decisions locked in

| Decision | Answer |
|---|---|
| Project name | LD ERP Solution |
| Database | Supabase, project **LD COTTON APPS** (`cpogaadkcefpeanxbqkb`), region ap-southeast-1 |
| DB isolation | Dedicated `ld_erp` Postgres schema, matching the existing `vhagar_fabric` / `vhagar_kandy` convention |
| Why not a new project | Saves $10/month, and LD Cotton owns this ERP anyway |
| Future | Software will be sold to other companies with customisation — each customer gets their own schema or project |

---

## What is built

**Database — live on Supabase**
- 83 base tables and 28 enum types in the `ld_erp` schema, counted on
  16 Sep 2026. That count includes Prisma's own `_prisma_migrations`, and the
  tables from the BOM migration that is applied to the database but **not in
  this repo** — see the top of this file
- Seeded: company, 5 roles, 2 users, 2 brands, 8 departments, 1 warehouse,
  8 UOMs, 7 item categories, 8 document number series
- 78-entry permission matrix with per-role grants
  (Admin 78, MD 39, Production 21, Store 19, Accounts 18)

**Foundation**
- pnpm monorepo: `apps/api`, `apps/web`, `packages/database`, `packages/shared`
- Both apps typecheck clean; the web app builds; the API boots and serves
- One shared `PrismaClient`

**Auth and access control**
- JWT login, refresh with rotation, `/me`, logout
- `requirePermission(module, action)` guards every endpoint, Admin bypasses
- Audit trail written on every master write and every approval

**Master data — Phase 1 complete**
- API: 11 masters through a shared CRUD factory, plus company and BOM
- Screens with create/edit forms: customers, suppliers, items, styles,
  warehouses, and a dedicated bill of materials screen
- BOM costing: wastage inflates consumed quantity, rate falls back to the
  item's standard rate, header total and lines written in one transaction
- Zod validation with real GSTIN, PAN, IFSC, HSN and PIN formats

**Dashboard — real data, no mock**
- KPI cards, revenue vs expenses trend, order status, production by line,
  low stock, recent orders, pending approvals
- Approvals work: approve moves a PO to SENT and an SO to CONFIRMED; reject
  cancels and records the reason on the document

**Sales and production**
- Sales orders end to end: list, form, detail, approval, amend, cancel,
  short-close and the order confirmation print (see the top of this file)
- Manufacturing order list with progress against planned quantity

**Inventory and stock**
- One writer for stock: `apps/api/src/services/stock.service.ts`. Nothing else
  may write `stock_ledger`. It refuses to go negative and names the shortfall,
  locks the item and warehouse so two issues cannot both pass the same check,
  and values everything at weighted average
- Balances are read back out of the movements, never stored, so quantity and
  value cannot drift apart
- Screens: stock on hand, one item's history, the full ledger, requisitions
- Documents that move stock: opening balance, adjustment after a count,
  transfer between stores, and issue against a requisition
- Material requisitions run raise → approve → issue, with three different
  people. The person who raised it cannot approve it, and both the inventory
  screen and the approvals inbox enforce that
- Customer-owned stock is held apart from ours and left out of the valuation
- The phone app can read stock and one item's history

**Purchase — orders, receipt and bills** (on `feat/purchase`, in a pull request)
- Purchase orders created from the UI: a five-section form with the enquiry it
  answers, the supplier, lines, delivery and terms
- The item picker's four fields stay in agreement. Choosing an item fills its
  category and subcategory; typing a full item code resolves that item. A stale
  selection clears itself when the list beneath it changes
- Goods receipt against an order, which is what finally lets a purchase
  increase stock
- Purchase bills with a three-way match: order against receipt against bill.
  A unique index stops the same supplier invoice being booked twice, which
  would claim the input credit twice
- **Deliver to a customer.** The supplier can be told to ship straight to a
  customer instead of to us. This is a tax change, not a delivery note: goods
  are taxed where they are delivered, so a supplier in our own state billing us
  for goods sent to a customer in another state raises IGST. The address is
  copied onto the order, not looked up, because a customer moves and an order
  already with a supplier must not move under it
- **File attachments**, up to five per order, 50MB each — the supplier's
  quotation, a sample approval, a signed copy that came back. The browser
  uploads straight to a private Supabase bucket and the API only handles the
  row; downloads go through a link the API signs, which dies after five minutes
- **The supplier's own addresses.** A supplier can bill from more than one
  place, so the addresses live on the supplier master and the order picks one.
  Picking one fills the billing block with its GSTIN and contact details, and
  the address is copied onto the order as text — the same reason the
  deliver-to-customer address is copied, so editing a master cannot rewrite an
  order already with a supplier. Adding or correcting an address from the order
  form saves it on the supplier, and the default address is mirrored back onto
  the supplier's own fields, which the printed sheet and the bill still read
- **The last rate an item was bought at**, under the Rate cell, with a
  "View history" panel listing every previous purchase of that item —
  order, supplier, rate, quantity, amount and date, newest first. A cancelled
  order is shown and labelled, not hidden: the rate was still quoted. Nothing
  in the panel changes the order; the rate is always typed
- **Reopen a sent order.** A sent order cannot be edited in place — the
  supplier is working from paper, and changing it underneath them is how a
  mill ends up arguing about what was agreed. It can be pulled back to a
  draft, which asks first, says plainly that the supplier's copy is about to
  be out of date, and is written to the activity log with who did it. Refused
  once a goods receipt or a bill exists against the order: those reconcile
  against it line by line, and an order that moved under them would put the
  two permanently out of step
- **Delete an order, into a recycle bin.** Cancel was the only way out before,
  which leaves a cancelled order in every list forever. Delete marks the order
  instead of removing it, so it drops out of every list, report, search and the
  assistant's reach, and Settings → Recycle bin puts it back exactly as it was,
  number and lines included. Only a draft or a cancelled order can be deleted,
  and never one with a receipt or a bill against it — those are somebody
  else's documents. Destroying one permanently is a second, separate action on
  that screen
- Terms and conditions come pre-filled from Settings → Documents, so the mill's
  four standard clauses are on the order without anybody retyping them
- A printed order sheet that paginates itself so its page numbers are true.
  It prints the delivery destination, and calls out a direct-to-customer
  delivery, because a supplier reading a sheet without it would ship to the
  letterhead address
- Item categories and subcategories have a masters screen

**Settings — five tabs**
- Company: profile and GSTIN, financial year, document numbering with a live
  preview of the next number, GST rates with one default
- People: add and edit users, reset a password, deactivate; roles with a
  permission grid (13 modules × 6 actions) that can be ticked by row or column
- Preferences: rows per page, date format, low-stock buffer, QC on daily
  production, days before an approval is called urgent
- System: connections checked live, change your own password, the full activity
  trail with filters and paging
- Recycle bin: purchase orders that were deleted, with restore and a separate
  destroy-permanently. Only purchase orders arrive there so far, and the page
  says so rather than implying everything deleted in the ERP lands there
- Guards that matter: you cannot deactivate yourself, change your own role, or
  remove the last administrator; built-in roles cannot be renamed or deleted;
  a role with people on it cannot be deleted; the Admin role cannot be narrowed
  (the auth middleware bypasses the matrix for it, so the screen says so rather
  than pretending otherwise); document counters cannot be edited by hand

**AI**
- Gemini function-calling service with 6 ERP tools and a daily MIS generator
- Needs `GEMINI_API_KEY` in `apps/api/.env` before it will answer anything

---

## What is not built yet

- Creating manufacturing orders from the UI. **Sales orders and purchase
  orders can now be created** — see above
- **Supplier payments.** A purchase bill can be raised and matched but not
  paid; the endpoint is a 501
- Accounts and HR are not built and now say so — 501, not an empty array
- Detail page `/production/orders/[id]`. A sales order opens in a dialog from
  the list, as purchase documents do
- Export buttons are visibly disabled rather than functional
- GST e-invoicing, WhatsApp bot, mobile app (Phases 2–5)
- The 4 extra AI tools from the abandoned attempt
- `experimental.typedRoutes` is off in `next.config.ts`; turn it back on once
  the sidebar's routes all exist, it catches broken links

---

## Bugs found and fixed in the recovered code

- All 16 Prisma enums were written on one line, which Prisma rejects — the
  client could not be generated at all
- `POST /auth/refresh` issued tokens without the permissions claim, so every
  non-Admin user would have lost all access 15 minutes after logging in
- The seed created no `Permission` rows, leaving the matrix empty and every
  non-Admin user refused everywhere
- `@radix-ui/react-badge` was a dependency but does not exist on npm — it broke
  every install
- `globals.css` used `@apply` with `group`, which Tailwind rejects — the web
  build failed on it
- `ai.service.ts` passed schema types as strings; the Gemini SDK needs its enum
- Five files each constructed their own `PrismaClient`
- The API tsconfig set `rootDir` to `./src` while importing workspace packages
  from outside it, and emitted declarations it cannot generate through pnpm's
  node_modules layout
- `packages/database/package.json` pointed its seed script at `src/seed.ts`;
  the file is `prisma/seed.ts`, and it imported `bcryptjs` without depending on it
- `packages/shared` was never a dependency of either app
- The dashboard's Approve button had no handler at all
- The notification bell held three fabricated alerts, including a payment of
  2.4 lakh supposedly received from a customer, with the unread dot permanently
  lit. Someone could have acted on any of it.
- The greeting, both avatars and the sidebar name were hardcoded to one person,
  so every user would have seen the same name and role
- The sign-out icon was decorative, and the theme toggle swapped its own icon
  without changing the theme
- The dashboard reported "of 1 target" on a day nobody had set one, because the
  API substituted 1 to avoid dividing by zero

---

## Notes for whoever picks this up

- **There are three `.env` files, not two.** `apps/api/.env`, `apps/web/.env.local`
  and `packages/database/.env`. The third is the one the Prisma CLI reads, and
  it is easy to miss because nothing mentions it until a migration command
  cannot find a database. A day was lost to `apps/web/.env.local` being empty:
  the login page called `/undefined/auth/login`, because it used raw `fetch`
  with no fallback while `lib/api.ts` has one.
- **`prisma migrate status` can give a false all-clear.** It printed "Database
  schema is up to date!" and exited 0 while the branch was three migrations
  behind the database. Do not trust it as a safety check — list the folders in
  `packages/database/prisma/migrations/` and compare them against
  `ld_erp._prisma_migrations` yourself.
- **Read the SQL before applying any migration.** One generated migration would
  have dropped four live stock tables, because the shared database was ahead of
  the branch it was generated on. It was caught by reading the file. Grep a new
  migration for `DROP` before it goes anywhere near the database.
- **The deploy script is `migrate:prod`, not `migrate:deploy`.** The docs named
  a script that does not exist.
- **`pnpm reset` is `prisma migrate reset --force`.** `--force` means there is
  no confirmation prompt. It wipes the ERP. It has no guard on it yet.
- **File attachments need a bucket, and no migration creates it.** A private
  Supabase bucket named `ld-erp-documents` with a 50MB limit, plus `SUPABASE_URL`
  and `SUPABASE_SERVICE_ROLE_KEY` in `apps/api/.env`. It already exists on our
  project; a fresh project would need it made by hand. The API returns a plain
  501 explaining itself if the variables are missing. Keep the bucket
  **private** — a purchase order carries prices and terms.
- **Supabase's signed upload URL carries its token in the query string.** Send
  it as an `Authorization: Bearer` header instead and you get a flat 400 with
  nothing useful in it.
- **`ld_erp` is not exposed to Supabase's public API**, which is why no RLS
  policy is needed on it. If the dashboard advises adding RLS, check which
  schema it means first.
- The init migration was applied through the Supabase connector before the
  database password was available, so Prisma did not know about it. It has now
  been marked applied (`prisma migrate resolve --applied 00000000000000_init`),
  and `prisma migrate dev` works normally from here.
- **Stop the API before running `prisma generate`.** The running server holds
  `query_engine-windows.dll.node` open and the generate step fails with EPERM
  partway through, which can leave the client half-written.
- Two tables were added for Settings: `tax_rates` and `app_settings`.
  `app_settings` is a key/value table, so adding a preference needs no
  migration — the catalogue of valid keys lives in
  `apps/api/src/schemas/settings.schemas.ts`, and that is also what stops
  arbitrary keys being written.
- `setup.ps1` runs install, generate, migrate and seed in one command, and
  refuses to start without enough memory or with the password placeholder still
  in place.
- **Never run `next build` while `pnpm dev:web` is running.** Both write to
  `apps/web/.next`, and they overwrite each other's files. The symptom is the
  site rendering as unstyled raw HTML: the browser asks for stylesheet chunks
  that no longer exist. The fix is to stop the dev server, delete
  `apps/web/.next`, start it again, and hard-refresh the browser with
  Ctrl+Shift+R. Stop the dev server before building, or the other way round.
- The PC hit its memory commit limit during this work and `pnpm install` failed
  until a restart. If installs start dying with `ERR_PNPM_ERR_MEMORY_ALLOCATION_FAILED`,
  that is the cause.
- **Another project on this machine (`Desktop\thehof`) also wants port 3000.**
  `START ERP.ps1` used to read any busy port as "the ERP is already running" and
  open whatever was there — somebody else's website. It now checks *whose*
  process holds the port, and moves the website to the next free one if ours
  cannot have 3000. The API's CORS accepts any localhost port in development for
  the same reason; in production it is still limited to `FRONTEND_URL`.
