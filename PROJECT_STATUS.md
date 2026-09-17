# LD ERP Solution — Where the project stands

_Last updated: Thu 17 Sep 2026 — BOM per colour, and a department per line_

This file is the running record of what is built, what is not, and what to do
next. Read it first after any break.

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

**The migration is written but NOT applied** — the team's hold on migrations is
still on. Until it is applied, the BOM screen on this branch will not load against
the shared database. See `MIGRATION-NOTES.md`.

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

## Deployment (Tue 25 Aug)

| Piece | Where | Address |
|---|---|---|
| Code | GitHub, **private** | github.com/gavhanemk/ld-erp-solution |
| Web app | Vercel, auto-deploys from `main` | https://ld-erp.vercel.app |
| API | Render free plan — **not created yet** | see `render.yaml` |
| Database | Supabase, already live | project `cpogaadkcefpeanxbqkb` |

The API cannot go on Vercel: it is a long-running Express process with
Socket.io and Vercel only runs code in short bursts. `render.yaml` is a
blueprint — in Render, New → Blueprint, pick the repo, and it reads the file.
Two values have to be pasted in by hand, `DATABASE_URL` and `DIRECT_URL`, both
in `apps/api/.env`. The JWT secrets are generated by Render itself rather than
copied from the development machine.

**Once Render is up**, the web app still has to be told where the API is:

    npx vercel env add NEXT_PUBLIC_API_URL production   # https://<render-url>/api
    npx vercel --prod

Until then https://ld-erp.vercel.app loads but nobody can sign in — it is still
pointing at localhost.

On the free plan the API sleeps after 15 minutes idle and takes roughly a minute
to wake. Fine for testing, not for the mill's daily use; moving to a paid plan
is a dropdown, not a rebuild.

**Next.js was upgraded 15.0.3 → 15.5.23** during the deploy. Vercel blocked the
first attempt outright because 15.0.3 carries the middleware authorisation
bypass (CVE-2025-29927). Do not pin it back.

---

## Where we left off (Mon 24 Aug, evening) — READ THIS FIRST

Mahesh went home mid-test. The purchase order works end to end and prints; the
last thing changed was the width of the columns on the printed sheet, and
**nobody has looked at the result yet**.

**First thing tomorrow:** open a purchase order, click the printer icon, and
check the line table lines up with the supplier box above it and the totals
below. If it does not, the column widths are weights in
`apps/web/src/app/(print)/print/purchase-order/[id]/page.tsx` and the maths that
turns them into percentages is in `DocumentTable` in
`apps/web/src/components/print/PrintSheet.tsx`.

Two print bugs were found and fixed today, both mine:
- The sidebar and top bar were on the print page and would have printed. Print
  pages now live in their own route group with no app shell.
- `overflow-wrap: anywhere` let a column shrink to one character, so the
  supplier address printed vertically, one letter per line. Never use
  `anywhere` in a table; `break-word` does not count towards a column's minimum.

**How he works:** short, plain sentences. No jargon, no file paths, no rule
numbers unless he asks. Answer the question first, then the detail.

**Live demo data he entered** — a supplier (LD Silk Mills), one item (LIO LINEN)
and PO-2627-0001 for ₹1,54,350. The HSN and some codes are deliberately not
real; he said not to worry about them, they are for testing.

**Decisions he has given:**
- No data comes across from Absolute ERP. Whatever is there stays there. Do not
  offer to migrate it again.
- Garment GST is 5%.
- LD Silk Mills is his own second company with its own GSTIN — a supplier here,
  never a second company inside one database.
- Users and roles can be reconfigured later; not a priority.

**Next after the print check:** Goods Receipt, so what arrives can be booked
against the order. `/purchase/grn` is still marked "soon" in the sidebar.

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
   which is what docs/03-build-rules.md asks for. What is left is goods
   receipt, still a 501 in `purchase.routes.ts`.
2. No screens yet for the new masters: workstations, brokers, routings, size
   groups, charge types.
3. Three models still have no route and no screen at all: `BankAccount`,
   `SalaryStructure`, `Voucher`.
4. Invoice creation. The purchase order prints; nothing else does yet.

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
- 76 tables and 27 enum types in the `ld_erp` schema
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
- Sales order list reads the real API with status filtering
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

**Settings — four tabs**
- Company: profile and GSTIN, financial year, document numbering with a live
  preview of the next number, GST rates with one default
- People: add and edit users, reset a password, deactivate; roles with a
  permission grid (13 modules × 6 actions) that can be ticked by row or column
- Preferences: rows per page, date format, low-stock buffer, QC on daily
  production, days before an approval is called urgent
- System: connections checked live, change your own password, the full activity
  trail with filters and paging
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

- Creating sales orders, purchase orders and manufacturing orders from the UI
  (the API can create sales orders; there is no form yet)
- **Goods receipt.** Stock has no inward document, so a purchase order does not
  increase stock when the goods turn up. Everything else about stock is built
- Accounts and HR are not built and now say so — 501, not an empty array
- Detail pages: `/sales/orders/[id]`, `/production/orders/[id]`
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
