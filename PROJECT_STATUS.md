# LD ERP Solution — Where the project stands

_Last updated: 21 Aug 2026_

This file is the running record of what is built, what is not, and what to do
next. Read it first after any break.

---

## One thing is left before you can log in

**The database password.** `packages/database/.env` and `apps/api/.env` still
contain `[YOUR-PASSWORD]`. Everything else is done — the tables exist on
Supabase and are seeded.

1. Supabase Dashboard → **LD COTTON APPS** → **Connect** → **ORMs** → **Prisma**
2. Copy the `DATABASE_URL` and `DIRECT_URL` it shows into both `.env` files,
   keeping `?schema=ld_erp` on the end of each
3. Replace `[YOUR-PASSWORD]` with the database password (use "Reset database
   password" on that page if you don't know it)

Copy the host from the dashboard rather than trusting the one already in the
file — Supabase assigns either `aws-0-*` or `aws-1-*` per project, and the wrong
one will not connect.

Then:

```
pnpm dev:api    # http://localhost:5000
pnpm dev:web    # http://localhost:3000
```

Sign in with:
- `admin@ldcottonmills.com` / `Admin@123`
- `md@ldcottonmills.com` / `MD@12345`

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
- 56 tables, 124 indexes, 71 foreign keys, 16 enum types in the `ld_erp` schema
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

**AI**
- Gemini function-calling service with 6 ERP tools and a daily MIS generator
- Needs `GEMINI_API_KEY` in `apps/api/.env` before it will answer anything

---

## What is not built yet

- Creating sales orders, purchase orders and manufacturing orders from the UI
  (the API can create sales orders; there is no form yet)
- Purchase, inventory, accounts and HR routes are still stubs returning empty
  arrays
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

---

## Notes for whoever picks this up

- The migration SQL is committed at
  `packages/database/prisma/migrations/00000000000000_init/migration.sql`. It
  was applied through the Supabase connector because the database password was
  not available, so Prisma's `_prisma_migrations` table does not know about it.
  Before the first `prisma migrate dev`, run
  `prisma migrate resolve --applied 00000000000000_init` or Prisma will try to
  create all 56 tables again.
- `setup.ps1` runs install, generate, migrate and seed in one command, and
  refuses to start without enough memory or with the password placeholder still
  in place.
- The PC hit its memory commit limit during this work and `pnpm install` failed
  until a restart. If installs start dying with `ERR_PNPM_ERR_MEMORY_ALLOCATION_FAILED`,
  that is the cause.
