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

All 56 of those files have been recovered into this project and committed. An
earlier, abandoned attempt also exists at `...\scratch\ld-erp` — its schema is
identical, but its `ai.service.ts` has 4 extra AI tools worth salvaging later
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

## Build state

### Done
- Monorepo: pnpm workspaces — `apps/api`, `apps/web`, `packages/database`, `packages/shared`
- Prisma schema: **56 models** covering every module through Phase 5 (auth, masters, sales, purchase, inventory, production, accounts, HR, AI, notifications)
- API: Express + Socket.io server, JWT auth (login / refresh / me / logout), error handler, logger, rate limiting
- API: real dashboard, sales and AI routes
- AI service: Gemini function-calling with 6 ERP tools
- Web: login page, dashboard shell (sidebar, topbar), KPI cards, charts, AI assistant widget, sales + production order pages
- `ld_erp` schema created in Supabase
- TypeScript configs for every package (none existed — nothing could compile)
- One shared `PrismaClient` in `packages/database/src/index.ts`
- Git repository initialised, everything committed

### Not done yet
- **Master data CRUD is stubs.** `apps/api/src/routes/master.routes.ts` returns empty arrays for customers, suppliers, items, styles, BOM, warehouses, departments, UOMs. This is the main gap in Phase 1.
- Purchase, inventory, production, accounts, HR routes are also stubs
- No Prisma migration has run — the `ld_erp` schema is empty
- Database not seeded
- RBAC middleware checks role name only; the permission matrix isn't enforced per endpoint
- No `packages/ui`, no `apps/mobile` (mobile is Phase 5)
- `pnpm install` has never completed on this machine

---

## Blocked on

1. **Memory.** The PC hit its commit limit (49.5 GB of 50.5 GB) with only ~800 MB
   available, so `pnpm install` dies with `ERR_PNPM_ERR_MEMORY_ALLOCATION_FAILED`.
   A restart is the fix. Needs ~3 GB free.

2. **Database password.** `packages/database/.env` and `apps/api/.env` both
   contain `[YOUR-DB-PASSWORD]` placeholders. Get the real password from
   Supabase Dashboard → LD COTTON APPS → Project Settings → Database →
   Connection string, or reset it there. Replace the placeholder in both files.

---

## Next steps, in order

1. Restart the PC, then run `pnpm install` in this folder
2. Paste the Supabase database password into the two `.env` files
3. `pnpm db:generate` then `pnpm db:migrate` — creates all 56 tables in `ld_erp`
4. `pnpm db:seed` — creates the company, roles, admin user, brands, departments, UOMs
5. Replace the master data stubs with real CRUD (the actual Phase 1 finish line)
6. `pnpm dev:api` and `pnpm dev:web`, then log in at http://localhost:3000

Seeded logins (after step 4):
- `admin@ldcottonmills.com` / `Admin@123`
- `md@ldcottonmills.com` / `MD@12345`

---

## Known bugs found in the recovered code

- `@radix-ui/react-badge` was listed as a dependency but does not exist on npm — removed, it broke every install
- `packages/database/package.json` pointed its seed script at `src/seed.ts`; the file is `prisma/seed.ts` — fixed
- The seed used `bcryptjs` without depending on it — fixed
- Every route file called `new PrismaClient()`, which opens a separate connection pool per file — a shared client now exists in `@ld-erp/database`, but **the route files still need to be switched over to it**
- `packages/shared` was never listed as a dependency of the web or api app — fixed
