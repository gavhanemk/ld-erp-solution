# Running and deploying

How to start it, fix it when it will not start, and put it live.

---

## 1. What you need on a new machine

- **Node 20 or newer** — nodejs.org
- **pnpm 9 or newer** — `npm install -g pnpm`
- **Git**
- Access to the private repository
- The database password (ask Mahesh — it is not in the repository)

---

## 2. First time setup

```bash
git clone https://github.com/gavhanemk/ld-erp-solution.git
cd "ld-erp-solution"
pnpm install
```

`pnpm install` also switches on the check that stops an accidental push to
`main`. See [team workflow](01-team-workflow.md).

Then create the two environment files. **They are not in the repository and never
will be.**

`apps/api/.env`

```
DATABASE_URL="postgresql://...pooler...:6543/postgres?pgbouncer=true&schema=ld_erp"
DIRECT_URL="postgresql://...:5432/postgres?schema=ld_erp"

JWT_SECRET="a long random string"
JWT_EXPIRES_IN="15m"
JWT_REFRESH_SECRET="a different long random string"
JWT_REFRESH_EXPIRES_IN="7d"

PORT=5000
NODE_ENV=development
FRONTEND_URL="http://localhost:3000"
```

`apps/web/.env.local`

```
NEXT_PUBLIC_API_URL="http://localhost:5000/api"
```

Then:

```bash
pnpm db:generate
pnpm db:migrate
pnpm db:seed        # only on a fresh database
```

Sign in with `admin@ldcottonmills.com` / `Admin@123`.

**Change that password before anyone real uses the system.**

---

## 3. Starting it every day

Easiest: double-click **START ERP.bat** in the project folder. It starts both
halves in their own windows, waits until they actually answer, and opens the
browser.

By hand:

```bash
pnpm dev          # both together
pnpm dev:api      # just the API   — http://localhost:5000
pnpm dev:web      # just the web   — http://localhost:3000
```

| Part | Address | Check it is alive |
|---|---|---|
| API | http://localhost:5000 | http://localhost:5000/health |
| Web | http://localhost:3000 | the login page loads |

If port 3000 is taken by another project on the machine, Next.js moves to
**3001** and the launcher follows it. That is normal — check the window for the
address it actually used.

---

## 4. When it will not start

### "EPERM" or "operation not permitted" during `pnpm db:generate`

The running API is holding the Prisma engine file open. This is a Windows thing.

```
1. Close the API window (or press Ctrl+C in it)
2. pnpm db:generate
3. Start the API again
```

### The web app will not build

Never run `pnpm build:web` while `pnpm dev:web` is running. They both write to
`apps/web/.next` and fight. Stop the dev server first.

### "Port already in use"

Something else is on it. Find and stop it:

```powershell
Get-NetTCPConnection -LocalPort 5000 | Select-Object OwningProcess
Get-Process -Id <that number>
```

Do not blindly kill it — it might be another project's server, not ours.

### Sign-in fails with "session expired" straight away

`JWT_SECRET` changed since the token was issued. Sign out and in again.

### The screen shows nothing and the console says "failed to fetch"

The API is not running, or `NEXT_PUBLIC_API_URL` points at the wrong place.
Check http://localhost:5000/health first.

### Changes to the schema are not visible in code

You changed `schema.prisma` but did not regenerate:

```bash
pnpm db:generate
```

---

## 5. Where it lives

| Part | Runs on | Address |
|---|---|---|
| Web app | Vercel | https://ld-erp.vercel.app |
| API | Render | not created yet |
| Database | Supabase | project `cpogaadkcefpeanxbqkb`, schema `ld_erp` |
| Code | GitHub | `gavhanemk/ld-erp-solution` (private) |

Vercel is set with **Root Directory = `apps/web`**. That matters — without it the
build cannot resolve the workspace packages.

### Deploying the web app

Automatic. Merge into `main` and Vercel builds it. Nothing to do.

To force one:

```bash
npx vercel --prod
```

### Deploying the API

[render.yaml](../render.yaml) in the repository root describes the service. To
create it the first time:

1. render.com → **New** → **Blueprint**
2. Pick the `ld-erp-solution` repository
3. Paste `DATABASE_URL` and `DIRECT_URL` when asked (copy them from `apps/api/.env`)
4. Apply

Everything else — the JWT secrets, the region, the build command — is already in
the file.

After it is live, point the website at it:

```bash
npx vercel env add NEXT_PUBLIC_API_URL production
# value: https://<the-render-address>/api
npx vercel --prod
```

**Until this is done, https://ld-erp.vercel.app loads but sign-in fails.** There
is no API behind it.

Note on the free plan: Render puts a free service to sleep after 15 minutes of
quiet, and the next request takes about 30 seconds to wake it. Fine for testing.
Not fine for the mill. Move to the paid plan before staff use it.

### Database changes going live

Migrations do **not** run automatically. After merging a schema change:

```bash
pnpm --filter @ld-erp/database migrate:deploy
```

Do it at a quiet hour. Take a backup first.

---

## 6. Backups

**This is the part that actually matters.** Code can be rewritten. Two years of
invoices cannot.

Supabase keeps automatic daily backups on the paid plan. On the free plan it
does not, and losing the database means losing everything.

Until the database is on a paid plan, take a manual backup weekly:

Supabase dashboard → Database → Backups → Download

Keep them somewhere that is not the same machine.

Before any of these, take a backup first:
- running a migration on the live database
- a bulk import
- anything that deletes

---

## 7. Secrets

| Secret | Where it lives |
|---|---|
| Database password | `apps/api/.env` locally, Render dashboard in production |
| JWT secrets | same, but production ones are generated by Render and are different |
| Gemini API key | inside the ERP, Settings → Assistant. Stored in the database. |
| Vercel and Render logins | Mahesh |

Rules:

- Never in the repository. `.env` is in `.gitignore` — keep it that way.
- Never in a chat message, a screenshot or a ticket.
- Production secrets are different from development ones. Never the same string.
- If one leaks, cancel it and issue a new one. Deleting the commit does not help
  — it stays in the history.

---

## 8. Before real staff use this

Not done yet. All of it needs doing before the mill depends on it.

- [ ] Change the admin password
- [ ] Real user accounts, one per person, with real roles — not everyone as Admin
- [ ] Database on a paid plan with automatic backups
- [ ] API on a paid Render plan so it does not sleep
- [ ] A restore actually tested — a backup nobody has restored is not a backup
- [ ] Someone other than Mahesh who can start, stop and restore it
- [ ] A written plan for what to do when it is down during working hours
