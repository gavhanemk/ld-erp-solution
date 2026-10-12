# Production — handover

Written 12 October 2026 for whoever takes the production module on from here.

Production is the part of the ERP between a sales order and finished goods:
the manufacturing order, its stages, the job cards, the cutting sheet, the
transfers between departments, every department's sheet to the last check, and
the outside units. This is how it is put together, what it guarantees, what is
not built yet, and the things that will bite.

Read [business processes](07-business-processes.md) first if you have not —
production there is described the way the mill runs it.

---

## 1. The one thing to understand first

**Every piece on the floor is counted in one ledger, and only
[`wip.service.ts`](../apps/api/src/services/wip.service.ts) writes to it.**

Two tables: `wip_events` (something happened — a cutting, a transfer sent, a
count, work recorded, a decision) and `wip_entries` (pieces of one bundle into
`+` or out of `−` one *place*). A place is a step of the order's route, a
**bucket** at that step, and — when an outside unit holds the pieces — the
unit:

| Bucket | Means |
|---|---|
| `TRANSIT` | Sent to this step, not yet counted in |
| `WIP` | In hand at this step (or held by the unit, with `vendorId`) |
| `DONE` | Done (passed, at a check) here, waiting to go on |
| `REWORK` | Being put right (`reworkStepId` says whose people) |
| `DAMAGED`, `REJECTED` | Waiting for a decision |
| `SHORT` | Missing on a transfer, waiting to be settled |
| `B_GRADE` | Set aside as seconds |
| `SCRAPPED`, `PACKED`, `PACKED_B` | Terminal: nothing moves out again |

The rules `postEvent` enforces, so nothing else has to:

- **Pieces move, they never appear or vanish.** An event's entries for each
  bundle add up to zero — except a cutting (which makes them), a split, and an
  undo.
- **Nothing is taken from a place that does not hold it.** Checked against the
  balance before anything is written; the refusal names the bundle and the
  place.
- **A balance is never stored.** It is the sum of the entries. So are all the
  figures on every screen.
- **Nothing is edited.** A mistake is undone by a `REVERSAL` event — the same
  entries turned round — and only while the pieces are still where it put them.

Every write first calls `lockMo` (`SELECT … FOR UPDATE` on the order), so two
people saving on the same order at once are taken one after the other. Every
function in [`floor.service.ts`](../apps/api/src/services/floor.service.ts) runs
inside the caller's transaction and takes that lock before reading a balance.
Keep it that way.

---

## 2. The flow, as the mill asked for it

This shape was settled with the business on 12 October after two other designs
were rejected. Do not collapse screens or merge steps without asking.

1. **Sales order → manufacturing order (MO).** Releasing an MO does *not* need
   a routing. Release makes one **job card** per MO line — one per colour or
   design.
2. **Materials first.** The MO raises its requisitions; the store issues them.
3. **Load stages.** Only once some material has been issued, the MO loads its
   stages from the routing for its style (the MO keeps its own copy, `mo_steps`,
   and can change it for itself).
4. **Process forms.** The stages give each job card its forms: the cutting
   sheet, then a sheet for every later stage to the last check.
5. **Cutting sheet.** Sizes are issued to a **cutting contractor**; what comes
   back cut is received against that issue, tied into **bundles**, and the
   bundle stickers print.
6. **Process transfers.** Every handover from one department to the next is a
   transfer with a printed card. The sender issues it; the receiving department
   **counts it in**. A shortfall is held as short until settled — never written
   over. To an outside unit the transfer is a **job-work challan** (JW series,
   for GST) under a job work order; the unit's return is counted back against it.
7. **Each stage's sheet** records what came in, what was processed, what went
   out, and what was damaged — bundle by bundle, as the paper sheets did.
8. **Into finished goods** from the last stage, through Inventory → Finished
   Goods In.

### Screens (Production menu)

| Screen | Path | What it is |
|---|---|---|
| Manufacturing Orders | `/production/orders` | The MO. Its **Production** section shows the three steps in order — materials issued, stages loaded, process forms by job card — and opens any sheet |
| Routings | `/masters/routings` | Opens on the **Styles** tab: each style, the routing it follows, and where it stands. A style's page (`/masters/routings/style/[id]`) has a **Start** and **Stop** for each step and the units completed there. **All routings** is the second tab. Process Master is under Masters |
| Job Cards | `/production/job-cards` | One per colour: header (order no., project ID, fabric quality, design no., metres, average, ratio, lot) and its forms |
| Process Transfers | `/production/transfers` | Tabs: to count in · short · at outside units · received · all. Count in, settle, print, cancel |
| Production Stages | `/production/stages` | **Every stage on one screen**, a tab each (cutting first, then process-master order) with the work waiting there; a row opens the job card's sheet |

The sheet itself is `SheetView` → `CuttingSheet` or `StageSheet`. Each opens
with a **"What to do now"** box listing what waits at that stage, each with its
button. The business asked for this to be "completely user friendly": keep
statuses in plain words and keep one obvious action per thing.

Prints: `/print/job-card/[id]`, `/print/sheet/[id]?step=` (the cutting sheet or
a process sheet, in the paper layout), `/print/transfer/[id]` (the transfer
card, or the job-work challan), `/print/bundles` (stickers, Code 128 drawn by
[`code128.ts`](../apps/web/src/lib/code128.ts) — no package), `/print/cutting/[id]`
(one lay).

---

## 3. Where the code is

### API

| File | Holds |
|---|---|
| `services/wip.service.ts` | The ledger: `postEvent`, `reverseEvent`, `balancesOf`, `flowsOf`, `lockMo` |
| `services/floor.service.ts` | Everything that moves pieces: `dispatch` (transfer), `receive` (count in), `settleShort`, `cancelTransfer`, `recordWork`, `decide`, `reworkDone`, `vendorReturn`, `sendBack`, `syncChallans`, `closeJobWorkOrder`, `packForReceipt`/`unpackForReceipt`, `undoEvent`, hold/resume; and the figures — `stepFigures` / `figuresFrom`, `syncProgress` |
| `services/cutting.service.ts` | `issueToCutter` (sizes to a contractor), `createCutting` (received cut → bundles + `CUT` event; with `issueId` it completes that issue), `cancelCutting`, `cuttingPrep` |
| `services/route.service.ts` | Routings: `checkRouteSteps`, `applyRouting` (copies steps to the MO), `editRoute`, `skipStep`/`restoreStep`, `nextStepAfter`, `isLastStep` |
| `services/jobCard.service.ts` | `ensureJobCards`, the job card lists, `stageSheets` / `stageTabs`, `jobCardDetail` (everything a sheet shows) |
| `services/floorView.service.ts` | `flowSummary` — the route, figures, bundles, transfers and job work of an MO, or of one job card |
| `routes/productionFloor.routes.ts` | The floor's endpoints, mounted under `/api/production` |
| `services/styleTrack.service.ts` | Routings by style: which routing a style follows, each step's Start / Stop / left out (`style_step_runs`, pressed by hand), and units completed per step, read from `stepFigures` over the style's order lines. **Separate from the ledger**: it never writes `wip_*`, and nothing on the floor reads it |
| `routes/styleTracking.routes.ts` | Its endpoints, mounted at `/api/masters/style-tracking` |
| `routes/production.routes.ts` | MOs, requisitions, the older cutting endpoints. `release()` makes the job cards |

### Web

Everything for the floor is in
[`components/production/floor/`](../apps/web/src/components/production/floor/):
`types.ts` (the shapes the API returns), `SheetView`, `CuttingSheet`,
`StageSheet`, `NextSteps`, `StageList`, `JobCardView`, `MoProductionPanel`, and
one dialog per action (`SendOnDialog`, `CountInDialog`, `SettleDialog`,
`WorkDialog`, `DecideDialog`, `ReworkDoneDialog`, `VendorReturnDialog`,
`SendBackDialog`, `CutterIssueDialog`, `CutterReceiveDialog`, `RouteEditDialog`,
`NewTransferDialog`, `TransferDetailDialog`).

A job card's detail has the same shape as an MO's `flowSummary`, filtered to
its own line — which is why the action dialogs take `flow` and work for both.

### Data

`Routing`/`RoutingStep` (masters) → `MOStep` (the MO's own copy) ·
`JobCard` (one per `MOLine`) · `CuttingOrder` (a lay: `IN_PROGRESS` while with
the contractor, `COMPLETED` when received) · `ProductionBundle` ·
`WipEvent`/`WipEntry` · `ProcessTransfer`/`ProcessTransferLine` ·
`JobWorkOrder`. The migrations and what they changed are in
[MIGRATION-NOTES.md](../MIGRATION-NOTES.md).

### Numbers

| Document | Number | From |
|---|---|---|
| Job card | `MO-2627-0001-JC1` | the MO |
| Lay / contractor issue | `MO-2627-0001-C1` | the MO |
| Bundle | `MO-2627-0001-B001` | the MO |
| Transfer on our floor | `MO-2627-0001-T1` | the MO |
| Job-work challan | `JW-2627-0004` | the **JW** number series — GST wants one series |
| Job work order | `MO-2627-0001-JW1` | the MO |

---

## 4. Rules worth knowing before you change anything

**Only the next step.** A transfer always goes to the next step on the order's
route (`nextStepAfter`, which skips steps left out). Nobody picks a destination.

**Sending from hand.** At a working step on our floor (stitching, finishing,
packing — `sendsFromHand`), pieces can go on straight from in hand, the way the
paper sheet had *In / Out / Damaged*; they count as processed there. At a check,
at cutting and at an outside unit, only pieces done (passed) go on. The same
rule lets a working last step pack straight into finished goods.

**Outside units do not count in on our system.** A challan puts the pieces in
the unit's hands (`WIP` with `vendorId`); `vendorReturn` brings them back as
accepted, failed or damaged. `syncChallans` marks challans "partly back" /
"back" from the returns — oldest challan first — after every return and every
undo of one. Charges are the accepted pieces of fresh work × the rate; rework
sent back is not charged again.

**Reworked pieces are not new production.** They were never counted done, so
putting them right counts them once.

**The figures are worked out, not kept.** `stepFigures` gives each step
received, completed, sent on, in hand, at the unit, damaged, short, yet to
come. `syncProgress` copies a few of them onto the MO (`progress`,
`totalStitchedQty`, `totalFinishedQty`) as a cache after every write — never
type them.

**Permissions.** Recording (send, count in, work, returns, cutting) is
`production:create`. Deciding, settling, undoing and changing a route is
`production:edit`. Writing pieces off, passing rejects as they are, leaving out
a required step, cutting more than the order and changing a released order's
route also need `production:approve`.

**Gates the business asked for.** Loading stages is refused until material has
been issued (in the route handler, `POST /orders/:id/routing`).
`issueToCutter` refuses the same, and refuses an MO without stages. Both check
"some material has been issued", not "every requisition fully issued" — see §5.

---

## 5. What is left, and why each matters

**Production does not move stock.** Finished goods come *in* through Finished
Goods In, but cutting does not consume fabric from the stock ledger and the
floor's pieces are not stock. The cutting sheet accounts fabric used and waste
against what was issued to the order (`cuttingPrep`), which is the check the
mill does by hand; posting consumption to the ledger is the next real gap.

**One routing per order.** An MO's stages apply to all its lines. An order that
mixes styles needing different routes cannot be loaded (`applyRouting` refuses
with `ROUTING_DOES_NOT_FIT`); split it into two MOs for now. Per-line routes
would mean `mo_steps` per line.

**Bundle split and merge.** The `SPLIT` event type and `ProductionBundle.parentId`
exist; nothing uses them yet. The original brief asks for authorised splitting
when part of a bundle goes ahead.

**"Materials issued" is loose.** It means some material is issued to the MO.
If the business wants every requisition fully issued before cutting, tighten it
in both places named in §4.

**Speed.** `jobCardDetail` reads a lot (≈ 3–5 s against the remote database).
`stageSheets` and `stageTabs` read every open job card and page in memory.
Fine at today's volume; move the paging into the query when there are hundreds
of open job cards.

**Job-work charges stop at the return.** The rate, pieces charged and the
unit's bill number are recorded on each return; nothing posts them to accounts.
Accounts is deliberately untouched for now.

**Leftovers.** `GET /production/job-work-orders` has no screen any more (outside
work shows on the stage's sheet). The sidebar's `qcInDailyProduction` filter
still names `/production/qc`, which no longer exists. The older one-step
cutting (`POST /orders/:id/cutting`, `CuttingDialog`) is kept for MOs without
stages — the job-work orders that put cut panels into a store.

---

## 6. Traps

**Stop the API before `prisma generate`.** On Windows the running server holds
the query engine DLL and the generate fails with `EPERM`.

**Never run `prisma migrate dev` or `db push`.** The shared database is ahead of
`main`. Hand-write the migration and apply it with `prisma migrate deploy`. Read
[MIGRATION-NOTES.md](../MIGRATION-NOTES.md) first.

**Never edit an applied migration.** `20261012150000_job_cards` once filled
Project ID from the sales order's Reference — which holds the quotation number,
so it was wrong. The rows were cleared and the code no longer does it, but the
migration file stays as it ran.

**Never run `prisma format` or `prettier --write`** on the schema or a file you
did not create; both rewrite hundreds of unrelated lines.

**A Next page file may only export its default component.** Exporting anything
else (a constant, a type) breaks the build.

**`useSearchParams` needs a `<Suspense>` boundary** or the build refuses the
route — see the print pages.

**No `dark:` Tailwind classes.** `<html>` always carries `dark`, so they leak
into the light theme. Use the theme tokens.

**Every number box is a `StepInput`** (wheel ±1, never below zero).

---

## 7. The runnable checks

Two end-to-end scripts drive the real services against the shared database
inside one transaction that always rolls back — nothing is kept and no number
series moves. They need the demo masters (listed at the top of each).

```bash
cd apps/api
npx tsx ../../tools/check-production-flow.ts    # 31 checks — the job-card flow
npx tsx ../../tools/check-production-floor.ts   # 91 checks — routes, transfers, QC, outside units
```

Run both after any change to `wip.service.ts`, `floor.service.ts`,
`cutting.service.ts` or `jobCard.service.ts`. They are the fastest way to know
nothing appears, vanishes or gets counted twice.

A third covers the per-style Start / Stop under Masters → Routings — its rules,
and that its units completed match `stepFigures`. Run it after any change to
`styleTrack.service.ts` or to `stepFigures`:

```bash
npx tsx ../../tools/check-style-tracking.ts     # 26 checks — start order, undo, leaving out, units
```

The demo data: **MO-2627-0001** was taken from quotation to finished goods with
an earlier version of the flow (its sheets show that history). **MO-2627-0002**
is a test order whose stages were loaded before the materials gate existed —
raise and issue its requisition to try the cutting sheet on it.

---

## 8. Open questions for the business

1. **Cutting contractors' pay.** Issues record the contractor and the pieces,
   not a rate. Are they paid per piece, and should the sheet total it?
2. **"Materials issued" before cutting** — some, or every requisition in full?
   (§5.)
3. **GST on job-work charges** — SAC 9988 is the default on job-work sales
   lines; confirm with the CA before charges are ever posted.
4. **Does the last check have to be the last stage?** Today finished goods take
   what the last stage has done, whatever kind of stage it is.

---

## 9. Where to start

One thing to read: `wip.service.ts`, then `dispatch` and `receive` in
`floor.service.ts`. Everything else is built on those three.

One thing to build: **stock consumption at cutting** (§5) — it is what makes
the fabric figure in Inventory true once production is running.
