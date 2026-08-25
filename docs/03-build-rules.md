# Build rules

How the code is organised and how to add to it. Follow the patterns that are
already here. A new module should look like the last one.

---

## 1. The layout

```
LD ERP Solution/
├── apps/
│   ├── api/          Express server — the brain. Port 5000.
│   └── web/          Next.js app — the screens. Port 3000 (or 3001).
├── packages/
│   ├── database/     Prisma schema, migrations, seed. The single source of truth.
│   └── shared/       Types and constants used by both sides.
├── docs/             These files.
└── tools/            One-off scripts. Never imported by the app.
```

It is a pnpm workspace. Install once at the root, never inside `apps/api`.

### Inside the API

```
apps/api/src/
├── index.ts          Boots Express, mounts routes, starts Socket.io
├── routes/           One file per module. All HTTP lives here.
├── schemas/          Zod validation. What the API will accept.
├── services/         Logic too big for a route file (currently: AI)
├── lib/              Shared machinery — crud, audit, docNumber, printData
├── middleware/       auth, errorHandler
└── utils/            logger
```

### Inside the web app

```
apps/web/src/
├── app/
│   ├── (auth)/       Login. No sidebar.
│   ├── (dashboard)/  The app. Sidebar and top bar.
│   └── (print)/      Printable documents. Nothing but the paper.
├── components/       Grouped by area: masters, settings, print, charts, layout
└── lib/              api client, utils, appSettings
```

The brackets are Next.js route groups. They pick the shell, not the URL. Putting
a print page inside `(dashboard)` would print the menu — which is a mistake that
was already made once.

---

## 2. Naming

| Thing | Style | Example |
|---|---|---|
| Prisma model | Singular, PascalCase | `PurchaseOrder` |
| Prisma field | camelCase | `totalAmount` |
| API route file | `<module>.routes.ts` | `purchase.routes.ts` |
| Zod schema | `create<Thing>Schema`, `update<Thing>Schema` | `createSupplierSchema` |
| React component | PascalCase file and function | `MasterTable.tsx` |
| Web page | Always `page.tsx` in a lowercase folder | `purchase/orders/page.tsx` |
| URL segment | lowercase, hyphenated | `/masters/item-categories` |
| Permission | `module:action` | `purchase:create` |
| Environment variable | UPPER_SNAKE | `DATABASE_URL` |

Money is always `Decimal` in Prisma, never `Float`. Floats lose paise.

---

## 3. The API contract

Every response has the same shape. Do not invent a new one.

Success, one record:

```json
{ "success": true, "data": { } }
```

Success, a list:

```json
{ "success": true, "data": [], "pagination": { "page": 1, "limit": 25, "total": 0, "pages": 1 } }
```

Failure:

```json
{ "success": false, "message": "Plain English", "code": "MACHINE_CODE" }
```

Every list endpoint accepts `?page=`, `?limit=`, `?q=`, `?sort=`, `?order=`,
`?active=`. `MasterTable` on the web side already sends them.

### Errors

Throw `AppError`. Never `res.status(500).send(...)`.

```ts
throw new AppError(
  'No numbering is set up for PURCHASE_ORDER. Add one in Settings → Company.',
  409,
  'NO_NUMBER_SERIES',
)
```

Three arguments: the message a mill clerk reads, the HTTP status, a code the
screen can branch on. The message is the important one — see the words section
of the [design rules](02-design-rules.md).

Status codes we use: 400 bad input, 401 not signed in, 403 no permission, 404
not found, 409 conflict or a rule refused it, 500 our fault.

A module that is not built yet returns **501 NOT_IMPLEMENTED**. Never an empty
array — an empty array looks like working software with no data, and that lie
costs a day of debugging.

---

## 4. Adding a master

Masters are customers, suppliers, items, warehouses — the reference lists.
There is a factory for them. Five steps, about forty lines total.

**1. Model** in [schema.prisma](../packages/database/prisma/schema.prisma). Give
it `id`, `isActive`, `createdAt`, `updatedAt` like the others.

**2. Migrate.** Stop the API first (see the [running guide](05-running-deploying.md)):

```bash
pnpm db:migrate
```

**3. Schemas** in [master.schemas.ts](../apps/api/src/schemas/master.schemas.ts).
Reuse the helpers that are already there — `tidyIdentifier` for GSTIN/PAN/IFSC,
`pickOne` for dropdowns, the `code` preprocessor for trim and upper case. They
exist because a supplier once refused to save over a lower-case GSTIN.

**4. Route** in [master.routes.ts](../apps/api/src/routes/master.routes.ts):

```ts
router.use(
  '/brokers',
  crudRouter({
    model: 'broker',            // the Prisma delegate
    module: 'masters',          // permission module
    entityType: 'Broker',       // name in the audit trail
    createSchema: createBrokerSchema,
    updateSchema: updateBrokerSchema,
    searchFields: ['name', 'code', 'phone'],
    sortableFields: ['name', 'code', 'createdAt'],
  }),
)
```

That one call gives you list, get, create, update and deactivate — all
permission-checked and all audited.

**5. Screen.** A folder under `masters/`, a `page.tsx`, columns and fields handed
to `MasterTable`. Copy the suppliers page.

Then add it to [Sidebar.tsx](../apps/web/src/components/layout/Sidebar.tsx) and
drop the `planned: true` flag if it was there.

---

## 5. Adding a transaction module

Transactions are orders, invoices, receipts — documents with lines, numbers, tax
and a status. The factory does not fit them. Copy
[purchase.routes.ts](../apps/api/src/routes/purchase.routes.ts) instead.

The shape of a create handler:

```ts
router.post('/orders', requirePermission('purchase', 'create'), async (req, res) => {
  const data = createOrderSchema.parse(req.body)

  const order = await prisma.$transaction(async (tx) => {
    // 1. number — atomic, inside the transaction
    const poNumber = await nextDocumentNumber(tx, 'PURCHASE_ORDER', data.poDate)

    // 2. tax — from the two-digit state codes, never a state name
    const tax = await purchaseTaxContext(tx, data.supplierId)

    // 3. price it — one function, so the screen and the print agree
    const totals = priceOrder(data.lines, data.discountAmount, tax.isIntraState, !tax.supplierIsUnregistered)

    // 4. freeze what must not drift — HSN copied onto the line
    // 5. create header and lines together
    return tx.purchaseOrder.create({ data: { ... } })
  })

  await writeAuditLog(req, { module: 'purchase', action: 'CREATE', entityType: 'PurchaseOrder', entityId: order.id, after: order })
  res.status(201).json({ success: true, data: order })
})
```

Five things that are not optional:

1. **Everything in one `prisma.$transaction`.** A number allocated and then a
   failed save leaves a gap in the series, and a gap in a GST series is a
   question you do not want to answer.
2. **`nextDocumentNumber(tx, ...)`** for the number. Never build it yourself.
3. **Tax from state codes.** Never from a state name.
4. **Copy values that must not drift** — HSN, rate, name — onto the line. If the
   item master is corrected next week, last week's order must not change.
5. **Audit the write.**

---

## 6. Permissions

13 modules × 6 actions = 78 permissions. They ride inside the sign-in token.

Modules: `dashboard`, `masters`, `sales`, `purchase`, `production`, `inventory`,
`accounts`, `hr`, `quality`, `reports`, `settings`, `approvals`, `ai`.

Actions: `view`, `create`, `edit`, `delete`, `approve`, `export`.

Guard **every** route:

```ts
router.get('/orders', requirePermission('purchase', 'view'), ...)
router.post('/orders', requirePermission('purchase', 'create'), ...)
```

A route with no guard is a hole. The reviewer checks for this.

The `Admin` role skips the check entirely. Because permissions live in the
token, changing someone's role takes up to 15 minutes to bite — that is the
access token lifetime, and it is deliberate.

---

## 7. The audit trail

Every create, update and delete is recorded: who, when, from which address, and
the whole record before and after.

```ts
await writeAuditLog(req, {
  module: 'purchase',
  action: 'UPDATE',
  entityType: 'PurchaseOrder',
  entityId: order.id,
  before,
  after: updated,
})
```

`crudRouter` does it for you. Hand-written routes must do it themselves.

Auditing never breaks the request — if the audit write fails it is logged and
swallowed. A lost audit row is bad; a customer update that failed because of a
lost audit row is worse.

**Never audit a secret.** The Gemini API key is deliberately kept out of the
preferences system so it cannot reach the audit trail. Keep it that way.

---

## 8. Validation

All input is validated with Zod before it reaches the database. No exceptions.

Two habits that matter:

**Clean before you judge.** A user typing `27 abcde 1234 f1z5` meant a valid
GSTIN. Strip and upper-case it first, then test it. That is what `tidyIdentifier`
does.

**Say what is wrong in plain words.** `pickOne('a supplier')` produces "Choose a
supplier from the list", not "Invalid enum value".

One gotcha: once a schema has `.superRefine()` on it you cannot call `.omit()` —
it is no longer a plain object. Keep a base object and refine a copy.

---

## 9. Money and dates

Money:

- `Decimal` in the database, never `Float`.
- Round to 2 places at every step, not only at the end.
- `applyRoundOff()` rounds the bill to the whole rupee and returns the
  adjustment. The adjustment is stored — a printed bill must add up.
- On screen `formatCurrency()`. On paper `money()`.

Dates:

- Store as `DateTime` in UTC. Prisma does it.
- Display with `formatDate()`, which follows the user's chosen format.
- The financial year runs April to March. `financialYearOf(date)` returns `2627`
  for the 2026-27 year. Never work it out by hand.

---

## 10. The database

The schema is the single source of truth. Roughly 76 models.

```bash
pnpm db:generate    # rebuild the Prisma client after changing the schema
pnpm db:migrate     # create and apply a migration
pnpm db:studio      # browse the data
pnpm db:seed        # load starter data
```

Rules:

- **Stop the API before `db:generate` on Windows.** The running server holds the
  Prisma engine file open and the command fails with a permission error.
- **Never edit a migration that has already been applied.** Write a new one.
- **Never `prisma db push` against the live database.** Migrations only.
- **Tell the team before you touch the schema.** It is the one file everyone shares.

Two things to know about the hosting: the app connects through a pooled
connection (`DATABASE_URL`), but migrations need the direct one (`DIRECT_URL`)
because the pooler cannot run them. Everything lives in the `ld_erp` schema, not
`public` — so a second company can be added later as its own schema without
touching this one.

---

## 11. Talking to the API from the web app

Always through [lib/api.ts](../apps/web/src/lib/api.ts). Never a raw `fetch`.

```ts
import { api, masterResource, ApiError } from '@/lib/api'

const res = await api.get<Single<PurchaseOrder>>(`/purchase/orders/${id}`)
const suppliers = masterResource<Supplier>('suppliers')
await suppliers.create({ name: 'ABC Textiles', gstin: '27AABCU9603R1ZM' })
```

The client already handles the token, refreshes it when it expires, retries the
request once, and turns validation errors into a field-by-field map. A raw
`fetch` gets none of that and will log the user out mid-form.

Catch `ApiError` and show `err.message`. It is already written for a human.

---

## 12. Do not

- Do not use `any` in TypeScript. The one exception is the CRUD factory, which
  reaches Prisma delegates by name and cannot be typed.
- Do not leave `console.log` in the API. Use `logger`.
- Do not add a package without asking. Every one is a thing to update forever.
- Do not hard-code "LD Cotton Mills" anywhere. Read it from the company record.
- Do not hard-code a tax rate, a prefix, a warehouse or a state. They are settings.
- Do not return an empty array for an unbuilt feature. Return 501.
- Do not commit generated files — `dist`, `.next`, the Prisma client.
