# Inventory — handover

Written for Harshali, 28 September 2026, taking the inventory module over.

You already know the purchase module, and inventory sits right underneath it:
every goods receipt you built writes stock through the one file described below.
This is what else touches it, what is finished, what is not, and the four or five
things that will bite.

---

## 1. The one thing to understand first

**[`apps/api/src/services/stock.service.ts`](../apps/api/src/services/stock.service.ts)
is the only code in the system allowed to write a stock movement.** Not "should
be" — is. If you ever find yourself wanting to insert into `stock_ledger`
directly, you want a document instead.

It enforces the four rules from [business rules §6](04-business-rules.md#6-stock):

**Stock is never negative.** An issue of 120 against 100 on hand is refused, and
the refusal names the shortfall — *"Only 100 mtr of Cotton Poplin in Fabric
Godown. You are trying to take out 120."* A storekeeper can act on that; "insufficient
stock" just sends somebody to go and count.

**Stock only moves through a document.** `recordMovement` throws if you do not
give it both a `referenceType` and a `referenceId`. There is no way to call it
without one.

**Every movement is a row; the balance is the sum of the rows.** Nothing keeps a
running total. `balanceOf` adds the movements up every time, and value is the
same sum priced at each row's own rate. This is why an item at zero quantity is
also at zero value, and it is what makes the stock figure defensible when
somebody questions it.

**Stock lives in a warehouse.** There is no such thing as a balance without one.

Two mechanisms are worth knowing:

- **A Postgres advisory lock per item + warehouse + ownership.** Two people
  issuing 60 against 100 on hand would both read "100 available" and both pass
  the check, leaving −20. The lock makes the second wait. It is held to the end
  of your transaction and released with it, so a crash cannot leave an item
  stuck.
- **Outward movements are priced at the running average, never at a rate the
  caller supplies.** Any other rate would leave value behind that no quantity
  accounts for.

Everything else in this document is documents feeding that one service.

---

## 2. What is built

### Reading stock

| Endpoint | What it answers |
|---|---|
| `GET /inventory/stock` | What is on hand, one row per item and store |
| `GET /inventory/stock/:itemId` | One item: where it is, and its last 50 movements |
| `GET /inventory/ledger` | Every movement, newest first. Read only, always will be |
| `GET /inventory/valuation` | Stock value by store and by category |

### Documents that move stock

| Endpoint | Document |
|---|---|
| `POST /inventory/opening` | Opening balance. Allowed once per item and store |
| `POST /inventory/adjustments` | A correction after a physical count — `ADJ-2627-0001` |
| `POST /inventory/transfers` | Moving stock between our stores — `STN-2627-0001` |
| `PATCH /inventory/transfers/:id/cancel` | Walks the goods back |
| `POST /inventory/requisitions` + approve / reject / issue | `MR-2627-0001`. Issue is where stock actually leaves |
| `POST /inventory/customer-grn` | A customer's own material in — `CGRN-2627-0001` |
| `POST /inventory/job-work` | Our fabric out to an outside unit — `JW-2627-0001` |
| `POST /inventory/job-work/:id/returns` | What came back — `JWR-2627-0001` |
| `POST /purchase/grn` | Goods receipt against a purchase order — yours |

### Screens

`inventory/stock`, `inventory/stock/[itemId]`, `inventory/ledger`,
`inventory/requisitions`, `inventory/documents` (transfers and adjustments),
`inventory/customer-material`, `inventory/job-work`. Plus stock on the phone app
under `apps/mobile/app/stock/`.

### The two directions of job work

These look alike and are not, and getting them the wrong way round is the easiest
mistake to make here.

**A customer's material** (`customer_grn`) is in our godown and is **not ours**.
It is written with `ownership: CUSTOMER_OWNED`, the customer's id, and **a rate
of zero**. The zero rate is the mechanism, not the filtering: value is derived as
`SUM((inQty - outQty) * unitRate)`, so a zero rate makes it worth nothing
*everywhere the ledger is read*, not only on the two screens that remember to
exclude it. Their poplin and ours in the same store are separate balances that
can never mix — the advisory lock token includes ownership.

**Our fabric at a job worker** (`job_work_challans`) is **still ours**. It simply
moved to a warehouse standing for that unit's floor, which is why "how much of
ours is at Ritesh Enterprises" needs no new reporting — it is on the stock screen
already.

A return is deliberately **two movements**, because what comes back is often not
what went out: forty metres of fabric return as three hundred cut panels. The
consumed material leaves the unit's balance, the made item arrives in ours, and
the value of the one carries into the other so cutting cloth does not change what
the mill is worth.

---

## 3. What is left, and why each matters

**Printing. Nothing in inventory prints.** Purchase has four printed documents;
inventory has none. Missing: the material issue slip the store and the department
both sign, the count sheet a keeper carries to the rack, the stock transfer note
that travels with goods, and — most urgently — **the job work challan**.

That last one is not a convenience. [Business processes §3](07-business-processes.md#job-work)
records that under GST, fabric leaving the mill needs a job-work challan or the
movement counts as a taxable sale. The document now exists in the database and
can be raised on screen; it cannot yet be printed and sent with the lorry. **Get
the wording confirmed by the CA before building the template** — do not put a
statutory declaration in code from a web search.

**Inward quality check.** `GRNStatus.QC_PENDING` and the `InwardQC` table exist
and nothing uses them. The old system's printed receipt has an "Inspected By"
line, so the mill expects it.

**Opening balances cannot be customer-owned.** `POST /inventory/opening` passes
no ownership, so material a customer left with us before go-live can only be
entered by raising a customer receipt for it. Fine for now; worth knowing.

**The AI assistant does not know about ownership.** Its stock tools do not filter
`CUSTOMER_OWNED`, so asked "how much poplin do we have", it may count a
customer's. Worth fixing when somebody next touches `apps/api/src/services/ai/`.

**Sales and production still do not move stock.** `TransactionType.SALE` and
`PRODUCTION` have **zero writers** outside the job work return. Selling goods
does not reduce stock and manufacturing neither consumes nor produces it. That is
sales' and production's work rather than inventory's, but until it is done the
stock figure is right for everything inventory touches and blind to the rest.
It is the single biggest gap in the module's usefulness.

---

## 4. A known defect, stated plainly

[Business rules §6](04-business-rules.md#6-stock) says a requisition is raised by
one person, approved by a second and issued by a third, and that both doors
enforce it.

**Two of the three are enforced.** The raiser cannot approve — checked in
`approvals.routes.ts:120` and `inventory.routes.ts:855`. But the issue route
never compares the issuer against the raiser or the approver, so one person can
raise something, have it approved, and then issue it to themselves.

The fix is a few lines in the issue handler. It was found while writing this
document and deliberately not bundled into unrelated work.

---

## 5. Traps

**Stop the API before `pnpm db:generate`.** On Windows the running server holds
`query_engine-windows.dll.node` open and the generate fails partway through with
`EPERM`, which can leave the client half-written.

**Never run `pnpm build:web` while `pnpm dev:web` is running.** They both write
to `apps/web/.next` and overwrite each other. The symptom is the site rendering
as unstyled raw HTML.

**Port 3000 on the LD machine is Open WebUI, through WSL.** Next binds it anyway
and WSL wins, so you get somebody else's site. Use
`pnpm --filter web dev --port 3005`.

**Never run `prisma format` or `prettier --write` on a file you did not create.**
Neither the schema nor most of the API is formatted to their liking, so both will
rewrite hundreds of unrelated lines. `prisma format` wanted 700 lines of the
shared schema for a 100-line change. Keep diffs to what you actually wrote.

**The database is usually ahead of `main`.** Read
[MIGRATION-NOTES.md](../MIGRATION-NOTES.md) before any schema change. The short
version: do not run `pnpm db:migrate` — hand-write the migration and apply it
with `db execute` plus `migrate resolve`, which cannot offer to reset anything.
And `prisma migrate status` **does not** protect you: it says "up to date" in
exactly the situation that gets the database offered up for reset.

**Switching branches under a running dev server** leaves Next serving a route
compiled without your page, and it hangs forever. Delete `apps/web/.next` and
restart.

---

## 6. The runnable checks

Three end-to-end scripts. Each drives the real API and asserts on the real
database, and each is behind a flag because they create documents that cannot be
deleted. **Demo database only.**

```bash
pnpm dev:api

node tools/check-grn.mjs --write-test-data             # 20 checks, goods receipt
node tools/check-stock-documents.mjs --write-test-data # 21 checks, transfers and counts
node tools/check-job-work.mjs --write-test-data        # 29 checks, customer material and job work
```

They are the fastest way to know you have not broken stock. Run all three after
any change to `stock.service.ts`.

### One of them is stale, and it is yours

`check-grn.mjs` was written before you changed the goods receipt, and three of its
assertions now test behaviour you deliberately replaced:

- It expects a receipt of 60 with 5 rejected to put **55** into stock. The route
  now pins `rejectedQty` to zero and books the full received quantity
  (`purchase.routes.ts:2361-2366`), so it puts in 60.
- It expects any over-receipt to be refused outright. It is now allowed within a
  tolerance if a reason is given — `OVER_RECEIPT_NEEDS_REASON`.
- The receipt count then follows from the first two.

I fixed the part that was unambiguous — every call now sends the supplier challan
number and date, which you made required — but left those three alone. They are
assertions about how *your* module should behave, and guessing at your intent
would be worse than a failing test that says exactly what changed.

---

## 7. Open questions for the business

Not code. Worth putting to Mahesh and the CA before building further:

1. **The job work challan wording.** What declaration does the CA want on it?
   Section 143 and Rule 45 get cited a lot online; do not act on that without
   confirmation. Related: whether the mill needs to file **ITC-04**, and whether
   anybody is tracking the one-year / three-year return deadlines.
2. **Does processed material go back to the customer through this system?**
   Customer material comes in; there is no document sending it back out.
3. **Is the mill charged for, or charging for, job work here?** The challan
   records the movement, not the money. Nothing bills the customer for processing
   or records what we owe the unit.
4. **Colour.** The old system has a colour dropdown on its receiving screen; our
   items carry colour in the name. Confirm that is acceptable before somebody
   adds a field.

---

## 8. Where to start

If you want one thing to read: `stock.service.ts`, top to bottom. It is 400 lines
and it explains itself.

If you want one thing to build: **the job work challan print page**, once the CA
has confirmed the wording. It is the only item on the list with a legal deadline
attached, and the machinery — `PrintSheet`, `DocumentTable` — is already there
from purchase.
