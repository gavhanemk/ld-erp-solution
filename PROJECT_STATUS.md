# LD ERP Solution — Where the project stands

_Last updated: 21 Aug 2026_

This file is the running record of what is built, what is not, and what to do
next. Read it first after any break.

---

## What happened before this file existed

The Gemini/Antigravity agent wrote a full first pass of the project, but its
work lived only inside the IDE's scratch workspace at
`C:\Users\Admin\.gemini\antigravity-ide\scratch\LD ERP Solution` and was never
applied to the real folder. The Desktop folder contained empty directories and
nothing else. Gemini then ran out of its plan quota.

All 56 of those files have been recovered here and committed. An earlier,
abandoned attempt also sits at `...\scratch\ld-erp` — its schema is identical,
but its `ai.service.ts` has 4 extra AI tools worth porting later
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

## Two things are blocking a running app

**1. Memory.** The PC is at its commit limit (~49.5 GB of 50.5 GB) with well
under 1 GB free. `pnpm install` gets as far as linking packages and then dies
when it cannot spawn a postinstall process. A restart is the fix; the install
needs roughly 3 GB of headroom. Uptime is currently 7+ days.

**2. Database password.** `packages/database/.env` and `apps/api/.env` both
still say `[YOUR-DB-PASSWORD]`. Get the real one from Supabase Dashboard →
LD COTTON APPS → Project Settings → Database → Connection string (or reset it
there), and replace the placeholder in **both** files.

Once both are sorted, one command does the rest:

```powershell
powershell -ExecutionPolicy Bypass -File .\setup.ps1
```

It checks memory and the password first, then installs, generates the Prisma
client, creates the tables and seeds the data.

Then:

```
pnpm dev:api    # http://localhost:5000
pnpm dev:web    # http://localhost:3000
```

Seeded logins:
- `admin@ldcottonmills.com` / `Admin@123`
- `md@ldcottonmills.com` / `MD@12345`

---

## What is built

**Foundation**
- pnpm monorepo: `apps/api`, `apps/web`, `packages/database`, `packages/shared`
- Prisma schema, 56 models, covering every module through Phase 5
- TypeScript configs for every package (none existed, so nothing could compile)
- One shared `PrismaClient` in `packages/database/src/index.ts`
- `ld_erp` schema created on Supabase
- Git repository with the full history of this work

**Auth & access control**
- JWT login, refresh with rotation, `/me`, logout
- `requirePermission(module, action)` enforcing the matrix carried in the token,
  with the Admin role short-circuiting
- 78-entry permission matrix seeded and granted across 5 roles
- Audit trail written on every master write

**Master data (the Phase 1 finish line)**
- `lib/crud.ts` builds list / get / create / update / deactivate per master:
  pagination, search, whitelisted sorting, active filter, audit on writes
- 11 masters wired to it; company and BOM have hand-written routes
- BOM costing: wastage inflates consumed quantity, unit cost falls back to the
  item's standard rate, lines and header total replaced in one transaction
- Zod validation with real GSTIN, PAN, IFSC, HSN and PIN formats

**Web app**
- Login, dashboard shell (sidebar, topbar), KPI cards, charts, AI chat widget
- `lib/api.ts`: attaches the token, retries once through `/auth/refresh` on a
  401, and shares one refresh promise so parallel requests cannot race each
  other through token rotation
- Master screens loading real data: customers, suppliers, items, styles,
  warehouses

**AI**
- Gemini function-calling service with 6 ERP tools, plus a daily MIS generator

---

## What is not built yet

- Forms to create and edit masters — the lists are read-only so far
- BOM screen (the API is ready, the UI is not)
- Purchase, inventory, production, accounts and HR routes are still stubs
  returning empty arrays
- Dashboard, sales and production pages still render mock data
- No `packages/ui`, no `apps/mobile` (mobile is Phase 5)
- No migration has run yet, so the `ld_erp` schema is still empty
- The 4 extra AI tools from the abandoned attempt are not ported

---

## Bugs found and fixed in the recovered code

- `@radix-ui/react-badge` was a dependency but does not exist on npm — it broke
  every install
- `POST /auth/refresh` issued tokens without the permissions claim, so every
  non-Admin user would have lost all access 15 minutes after logging in
- The seed created no `Permission` rows at all, leaving the matrix empty and
  every non-Admin user refused everywhere
- Five files each constructed their own `PrismaClient`, one connection pool per
  file — all now share one
- `packages/database/package.json` pointed its seed script at `src/seed.ts`;
  the file is `prisma/seed.ts`
- The seed imported `bcryptjs` without depending on it
- `packages/shared` was never a dependency of the web or api app
