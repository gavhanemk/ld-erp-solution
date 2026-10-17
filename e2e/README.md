# LD ERP end-to-end tests

Two kinds of tests, both run against a running ERP:

- **API suites** (`api/`): six scenario scripts that go through a whole flow over the API (job-work orders, job work out and back, customer goods receipts, cutting, sheet import, ITC-04 reports). Each one prints a PASS or FAIL line for every check, then `N passed, M failed`.
- **Browser walk** (`browser/`): one LD Cotton Mills order (Kingsley Twill Chino, Khaki) made from start to finish in the real web app, driven by Playwright in Google Chrome.

## Safety rule

These tests **write data**. They run only against the local demo database (`lderp_demo` on port 5433) and an API that is using it:

- Every script checks `SELECT current_database()` and refuses to run unless it is `lderp_demo`.
- After signing in, every script checks that the sign-in was recorded in the demo database. If it was not, the API is using another database, and the script stops before writing anything.
- No passwords, tokens or real database addresses are kept in these files. You pass them in your shell for each run. Never point `E2E_DB`, `DATABASE_URL` or `DIRECT_URL` at the real database.
- The tests use LD Cotton Mills styles, items and customers only, never VHAGAR ones.

## Setup (once)

The commands below are for PowerShell, run from the repo root unless they say otherwise. This folder is outside the pnpm workspace on purpose, so it uses npm.

```powershell
cd e2e; npm install          # pg, playwright (uses your installed Chrome) and embedded-postgres
```

**1. Start the demo database.** Leave it running in its own window.

```powershell
cd e2e; npm run db:start -- --init   # the first time only: makes demo-db/data and the lderp_demo database
cd e2e; npm run db:start             # every time after that
```

**2. Apply the schema to the demo database.** Use the demo address, never the real one.

```powershell
$env:DATABASE_URL = "postgresql://postgres:demo@localhost:5433/lderp_demo?schema=ld_erp"
$env:DIRECT_URL   = $env:DATABASE_URL
pnpm --filter @ld-erp/database exec prisma migrate deploy
```

**3. Copy the masters from live (read only).** This opens the live database in a read-only session and copies the master tables (users, items, styles, customers, suppliers and so on) into the demo. Nothing on live can change.

```powershell
$env:LIVE_DIRECT_URL = "<the live direct connection string>"
cd e2e; npm run db:copy-masters
```

`npm run db:reset` does the same, but first empties every table in the demo. Use it to start again from masters only (the browser walk needs this, see below).

**4. Start the API on 5101 and the web app on 3301 against the demo database.** Use one window for each.

```powershell
# API
$env:PORT = "5101"
$env:FRONTEND_URL = "http://localhost:3301"
$env:DATABASE_URL = "postgresql://postgres:demo@localhost:5433/lderp_demo?schema=ld_erp"
$env:DIRECT_URL   = $env:DATABASE_URL
pnpm --filter api dev

# Web
$env:NEXT_PUBLIC_API_URL = "http://localhost:5101/api"
pnpm --filter web exec next dev --port 3301
```

Variables you set in the shell override the `.env` files, so the API and web app use the demo database even when your `.env` points elsewhere.

## Running the tests

Set the sign-in for this shell only:

```powershell
$env:E2E_EMAIL = "<an admin user's email>"
$env:E2E_PASSWORD = "<that user's password>"
cd e2e
npm run test:api            # all six suites in order, then a summary table; exits non-zero if any check failed
npm run test:api -- cgrn    # only the suites whose file name contains "cgrn"
npm run test:walk           # the browser walk, headless
$env:SLOW = "1"; npm run test:walk -- --headed   # the walk in a Chrome window, at a pace you can watch
```

Some suites also sign in as three test users (`zztest.keeper`, `zztest.qc`, `zztest.sales` at ldcottonmills.com). If they are not in the demo, the suite creates them with the password in `E2E_STAFF_PASSWORD`, or `E2E_PASSWORD` when that is not set. If they already exist with another password, set `E2E_STAFF_PASSWORD` to it.

Optional settings: `E2E_API` (default `http://localhost:5101/api`), `E2E_WEB` (default `http://localhost:3301`) and `E2E_DB` (default `postgresql://postgres:demo@localhost:5433/lderp_demo`).

### Things to know

- **The API suites can run again and again.** Each run makes its own orders, receipts and challans, with numbers that are new each time. Run them in the order `test:api` uses: on a fresh demo database, later suites use records that earlier ones made.
- **The browser walk runs once per fresh demo database.** It makes a new item, BOM and routing for its style (`browser/configs.mjs`). It checks first and stops if that style already has a BOM or a routing. Run `npm run db:reset` before you run it again. The walk stops at the first step that fails, says which one, and saves a screenshot in `browser/shots/`.
- **Three ITC-04 checks need the walk.** Its production challan to an outside unit is what checks T7, T15 and T16 look at. If there is no such challan in the current half-year, those checks are shown as SKIP, not as failures.
