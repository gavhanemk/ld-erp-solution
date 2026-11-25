# Sampling — handover

Written 25 November 2026 for whoever takes sampling on from here.

Sampling is the part of the ERP that runs a buyer's sample: from the tech pack
that arrives with the request, through buying the material, making the pieces,
checking and sending them, the buyer's word colour by colour and what the
sample cost, to the handover that gives bulk production its BOM and route.

This document covers the whole rebuild: why it was done, the instructions and
decisions it was built to, how the process runs end to end, the logic behind
each rule, where the code is, what it changed in other modules, how to run and
test it, what is left, and the traps.

**Status.** All nine phases (0–8) are built, reviewed and committed on the
branch `feat/sampling-local`, which branched from `main` at `2a47e65`. On
25 November `main` (then `3c8cb6b`) was merged in, the sampling migrations were
renamed to sort after `main`'s, and the branch went up as a pull request to
`main`. It has run only against the isolated local pilot database, never the
shared one. Merging it switches nothing on: Sampling stays off on a server
until `SAMPLING_ENABLED` is set. What is left, and how to switch it on, is in
[section 13](#13-what-is-left-before-switching-it-on).

| Phase | Commit | Date | What it built |
|---|---|---|---|
| — | `44fc2ad` | before 16 Nov | Checkpoint: the earlier pilot, before the rebuild |
| 0 | `491da69` | 16 Nov | Groundwork: local file storage, Merchandiser role, pilot masters |
| 1 | `81511a2` | 16 Nov | Request intake, tech-pack files, development styles |
| 2 | `66d2d7b` | 16 Nov | Colour × size grid, sample BOM, route from the process master |
| 3 | `31834e2` | 17 Nov | Buying for a sample; the Sample Store kept apart |
| 4 | `ccc0ce8` | 17 Nov | Issue from the request's own material; waive; close out leftovers |
| 5 | `2f78836` | 17 Nov | Making colour by colour and size by size; transfers; outside units; labour |
| 6 | `992edd8` | 17 Nov | QC per colour; Sample Delivery Challan; the buyer's word per colour |
| 7 | `51a7e04` | 21 Nov | Charges, cost sheet, finalising the costs, two prints |
| 8 | `f2f617b` | 21 Nov | Handover to bulk: draft BOMs, routing, style made production |

Read [business processes](07-business-processes.md),
[inventory handover](08-inventory-handover.md) and
[production handover](09-production-handover.md) first if you have not —
sampling leans on both modules and deliberately stays out of the second one's
engine.

---

## Contents

1. [The one thing to understand first](#1-the-one-thing-to-understand-first)
2. [Why it was rebuilt](#2-why-it-was-rebuilt)
3. [Instructions and decisions it was built to](#3-instructions-and-decisions-it-was-built-to)
4. [The flow, end to end](#4-the-flow-end-to-end)
5. [What each phase built](#5-what-each-phase-built)
6. [Where the code is](#6-where-the-code-is)
7. [Every action, who may do it, what it checks](#7-every-action-who-may-do-it-what-it-checks)
8. [Rules worth knowing before you change anything](#8-rules-worth-knowing-before-you-change-anything)
9. [Other modules: used and changed](#9-other-modules-used-and-changed)
10. [Running it on your machine](#10-running-it-on-your-machine)
11. [The runnable checks](#11-the-runnable-checks)
12. [Traps](#12-traps)
13. [What is left before switching it on](#13-what-is-left-before-switching-it-on)
14. [Open questions](#14-open-questions)
15. [Where to start](#15-where-to-start)

---

## 1. The one thing to understand first

**Every change to a sample goes through one function, `actOnSample`, in
[`sampling.service.ts`](../apps/api/src/services/sampling.service.ts).**

The route `POST /sampling/:id/actions` takes `{ version, roundId, action, data }`
and hands it to `actOnSample`, which, inside one database transaction:

1. **Locks the request row** (`SELECT … FOR UPDATE`), so two saves on one
   sample run one after the other.
2. **Checks the version** the screen last saw. A save from a window that is out
   of date is refused (`STALE_SAMPLE`) instead of overwriting someone else's work.
3. **Applies the request-wide gates**: a cancelled request takes only the few
   actions allowed after cancelling; finalised costs refuse anything that would
   change them (`COST_FINAL`); only the latest round is changed, except for
   material entries and labour/charges, which may land on an earlier round.
4. **Checks permission**: `sampling:approve` for the merchandiser's own calls,
   `sampling:edit` for everything else (see [section 7](#7-every-action-who-may-do-it-what-it-checks)).
5. **Runs the action's rule**, either in `sampling.service.ts` itself or in the
   service for its family (making, review, cost, handover).
6. **Writes a history event** (`sample_events`), raises the request's version
   and recomputes the request's state from its latest round.

After the transaction the route writes the audit log (and, where the action
touched a Masters record — a style, a BOM, a routing — a Masters audit row
under that record's own name).

**The second thing:** the arithmetic the server checks is written once, in
`packages/shared/src/`, and the screens use the same functions. The making
ledger, colour outcomes, the round's verdict, handover readiness, the cost sheet
and the handover's BOM lines are all shared. The "What to do now" box and every
button read the same rules the server applies, so the screen does not offer
what the server would refuse.

**The third thing:** a sample is never stock and never production. Sample
pieces do not enter inventory or finished goods; no manufacturing order is
made, before or after handover. Material bought for a sample is real stock, but
it lives in a store of its own and only Sampling issues it.

---

## 2. Why it was rebuilt

The merchandiser's real process did not fit the first pilot:

| The real process | The first pilot |
|---|---|
| A sample starts from a buyer's **tech pack**, usually for a **style that does not exist yet** | A round needed an existing style |
| Material is **bought for that sample**, not taken from general stock | Material was issued from any general store |
| Purchase → a **sample-only stock pool** → the sample | No link between a sample and a PO or GRN |
| Making needs **BOM details, a route and process transfers** | Making steps were free-text names |
| The sample goes to the client with **what it cost** (material + labour + other) | Cost was material value only; handover needed a BOM that already existed |

The rebuild turns it into one connected flow:

> Request + tech pack + development style → specification with sample BOM and
> route → sourcing on linked POs → receipt into a Sample Store → issue to the
> sample → making with transfers, outside units and labour → QC → dispatch on
> a Sample Delivery Challan → buyer decision per colour → costing → handover
> that makes the bulk BOM.

---

## 3. Instructions and decisions it was built to

### 3.1 Business decisions (project owner, 16 November 2026)

| Topic | Decision |
|---|---|
| Where sample material comes from | **Bought for that sample only**, never from general stock |
| Who raises sample POs | **Either** the merchandiser (from Sampling) **or** the purchase team (from Purchase). Both link the PO line to the sample's BOM line |
| Leftover sample material | Minor (fabric is bought to sample metres). Close-out defaults to "used in this sample"; moving it to a general store is optional |
| Labour | The merchandiser types ₹ per step. **No rate master** |
| What the cost is for | 1. Internal cost sheet. 2. Starting point for the bulk BOM costing. 3. A client PDF: a **"Sample charges" statement** (what the sample cost to make) |
| Not in scope | Billing through a GST sales invoice; posting sample cost to Accounts |
| Style | Usually new. Sampling makes a **development style**, which becomes a production style at handover |
| Outside work (embroidery, print, wash, contractor) | Used **sometimes**. Keep it simple: who took the pieces, what came back, the charge, a job-work challan |
| Colours | **Several colours per round** (colour × size quantities); the buyer decides **per colour** |

### 3.2 How the work was to be done

- **Phase by phase.** Build a phase, verify it, have it reviewed by
  independent reviewers, fix what they find, commit it locally on
  `feat/sampling-local`, report in plain language, then **stop until asked for
  the next phase.**
- **Local pilot only** until the whole thing is built and tested. Then the
  merchandiser tests it, then **a pull request to `main`** (`main` is protected
  by the pre-push hook; never push to it directly).
- **Each phase usable on its own** in the pilot. The pilot database is
  fictional and is rebuilt by `sampling-local.ps1 -Action Prepare` whenever its
  shape changes.
- **No new npm packages** without asking.
- **Never edit a migration that has been applied.** Migrations are written by
  hand, additive, and tested on a fresh database (see [section 10](#10-running-it-on-your-machine)).
- **Do not stop a running pilot** without asking whoever started it.
- **Leave alone** the untracked files `apps/web/src/components/production/floor/RedirectDialog.tsx`
  and `apps/web/src/components/reports/PivotTable.tsx` (not part of this work),
  and do not commit the local change to `apps/web/next-env.d.ts`.
- The team handbook's six rules apply as everywhere (see [docs/README.md](README.md)):
  numbers only from `nextDocumentNumber()`, masters deactivated never deleted,
  existing components reused, no invented colours or fonts, no secrets committed.

### 3.3 Safety rules (non-negotiable)

- **`apps/api/.env` and `packages/database/.env` point at the shared live
  Supabase database** used by the team. Never run `prisma migrate dev`,
  `db push`, seeds or `pnpm db:*` against them.
- Database work for sampling happens **only** on the pilot cluster
  (`127.0.0.1:55439`, database `lderp_sampling`) or a scratch database on the
  same cluster.
- Two gates in [`lib/pilot.ts`](../apps/api/src/lib/pilot.ts). While the
  module was built, both were one strict pilot gate; they were split when it
  went up for merging, so the live server can run it:
  - `samplingEnabled()` — the module's switch, `SAMPLING_ENABLED=true`. The
    sampling routes, Sample Stores, sample needs in Purchase, the PO-line link
    and the `SAMPLE`/`SDC` series in Settings ask it. Off unless set. The
    screens ask `NEXT_PUBLIC_SAMPLING_ENABLED`, set beside it.
  - `samplingPilotEnabled()` — files on local disk only. The switch must be on,
    the server must not be in production mode, and **both** database URLs must
    point at loopback `lderp_sampling` with no `?host=` or `?hostaddr=`
    override. A flag left on against the live connection string puts no file
    on anybody's disk; the live server uses the storage bucket.
- Every check script asserts `current_database() = 'lderp_sampling'` before it
  writes anything.

### 3.4 Design choices taken, and why

| Choice | Why | Rejected alternatives |
|---|---|---|
| **Sample Store = a warehouse with `purpose = SAMPLING`, plus a per-request pool worked out from documents** | The warehouse is already part of every balance, lock and average, so sample and bulk stock never blend with no change to the stock key. The pool is summed from PO, GRN and issue rows every time, never kept as a counter, so it cannot drift | Reservations (need an MR, are soft, cannot hold before receipt); a new stock-key dimension (34 raw-SQL readers to change); customer-owned stock (carries no value, breaks closing stock) |
| **Direct PO-line link** (`PurchaseOrderLine.sampleMaterialId`) with two entry points | Mirrors "Select from indent"; avoids the three-person MR rule. Releasing the sample round is the approval | The MR → indent → PO chain |
| **Sample making stays outside the MO engine** | Process transfers, bundles, WIP and job-work orders all need an MO, and an MO needs a sales order; ~46 queries would need a sample filter. Sampling reuses the masters (processes, departments, contractors, job workers, routings and their rules) and the JW number series instead | Running samples as MOs |
| **The sample BOM lives in sampling tables until handover** | A sample BOM in the `bom` table would feed quotations, finished-goods valuation and style-edit guards. At handover a DRAFT production BOM is made per approved colour and Masters approves it as usual | Writing sample BOMs straight into `bom` |
| **Sample pieces never become stock** | The sales delivery challan needs a sales order, FG items and a stock-out. A non-stock Sample Delivery Challan carries the pieces | Using the sales challan |
| **Changes to shared modules are additive and gated** | New columns are nullable or defaulted; guards fire only for sample stores and development styles; sample pickers in Purchase show only when sampling is on. Production behaviour is unchanged until rollout | — |

---

## 4. The flow, end to end

The request opens in the sampling workspace (`/sampling`). Its sections, in
order: **Brief → Technical → Sourcing → Materials → Making → Quality → Buyer
review → Costing → Handover**, plus **History**. The "What to do now" box
(`sampleFlow` in [`samplingFlow.ts`](../apps/web/src/components/sampling/samplingFlow.ts))
always names the next step and the section it is in.

A round moves through these states:

```
DRAFT ──RELEASE──▶ RELEASED ──QC──▶ QC_PASSED ──DISPATCH──▶ SUBMITTED ──DECIDE──▶ APPROVED
                      ▲               │                                      ├──▶ CHANGES_REQUIRED ──NEW_ROUND──▶ (next round, DRAFT)
                      │               └──▶ QC_FAILED ──NEW_ROUND──▶ …        └──▶ REJECTED
                      └── a QC that failed can be recorded again on the same round
CANCEL on the request: CANCELLED (the request keeps its history; leftovers and late bills are still recorded)
```

### Step 1 — Raise the request (Brief)

- Buyer, brand, buyer's reference and **buyer's style ref**, season, garment
  category, required date, owner, brief. Number from the `SAMPLE` series
  (`SMP-<financial year>-NNNN`, e.g. `SMP-2627-0001`).
- **Files**: tech pack, pattern, photo, approval, dispatch slip, other. Up to
  five per kind per request and per round; PDF, image or spreadsheet; 50 MB.
  A tech-pack file on a **released** round is kept for good (`FILE_KEPT`);
  files added later stay removable with a reason. Every upload and removal is
  a history event.
- **The style**:
  - **New style** (the usual case): `CREATE_STYLE` makes a **development
    style** — brand from the request, name, category, size run, colours — with
    its code from the style-code series (`nextStyleCode`), on sampling rights
    alone. The code is previewed before saving.
  - **Re-sample**: `LINK_STYLE` links an existing production style.
  - A development style is refused by sales orders, quotations, BOMs,
    routings, MOs, finished-goods receipts and garment tags
    (`STYLE_IN_DEVELOPMENT`, [`lib/styleStage.ts`](../apps/api/src/lib/styleStage.ts)),
    is hidden from production pickers, and its brand, size run and colours
    cannot be changed from Masters while it is in sampling. Edits from
    sampling (`UPDATE_STYLE`) lock the style row and write a Style audit row.

### Step 2 — Write the specification (Technical)

The specification is saved as a draft any number of times (`SAVE_DRAFT`,
`SAVE_SPEC`) and released by an approver (`RELEASE`). Five tabs:

1. **Style & colours** — several colours, each with pieces per size. Colours
   must be the style's own (`NOT_STYLE_COLOUR`).
2. **Measurements** — per size, shared across colours: target and tolerance.
3. **Materials (the sample BOM)** — one row per line, saved from the first
   draft with a stable id: part (component), material (item), colour or all
   colours, quantity per piece, wastage %, **required quantity** (worked out,
   or typed with a reason), **bought or buyer-supplied**, expected rate,
   remarks.
   - Required = pieces of that colour (or all) × qty per piece × (1 + wastage),
     to 3 decimals.
   - One line per part + material + colour; an all-colours line and a
     one-colour line of the same part and material are refused as overlapping.
   - A missing material can be **quick-added** from the grid by the item
     master's own rules (code from its category, name unique ignoring case),
     without Masters rights. Raw material, trims, packing and consumables only.
   - The store is not chosen here; it is picked at the first issue.
4. **Route** — ordered steps taken from Masters → Processes, or filled from the
   style's routing or the usual route. Each step: process, department (the
   process's own), in-house (optionally a contractor who does that process)
   or at an outside unit (a supplier marked as job worker), instructions.
   Checked by the routing master's own rules: **cutting first, and once**; a
   contractor must do that step's process. No rates are copied: labour is typed
   later.
5. **Review & release** — lists every gap (`sampleSpecGaps`). Release needs at
   least one colour with pieces, a measurement for every size in use, BOM
   lines, and a valid route. On release the specification is **frozen**; a
   change after that is a new round.

### Step 3 — Buy the material (Sourcing)

- Per BOM line: required · ordered (PO numbers, supplier, expected date) ·
  received · still to buy. Material already issued counts as covered; a
  short-closed line or a cancelled order counts what arrived.
- **Raise purchase order** opens the normal purchase order form pre-filled with
  the selected lines and the Sample Store as the delivery store. The purchase
  team's own form has **Select from sample needs** beside Select from indent.
  Either way the PO line carries `sampleMaterialId`.
- A PO line may buy for a sample line only if: same item; the line is bought,
  not buyer-supplied; not a service order; not delivered to a customer; not
  also an indent line; the request is open and its round released. **Ordering
  more than is still needed asks for a reason** (`sampleOverReason`, e.g. the
  mill's minimum). The link is checked on create, on edit (links are carried
  through the line rebuild; an existing link is kept but not grown once the
  sample closes), on line reopen and on restore.
- **Receipts**: a sample-linked PO line can be received only into a Sample
  Store, and nothing else can be received into one.

### Step 4 — Prepare the material (Materials)

- **The request's pool** ([`samplePool.service.ts`](../apps/api/src/services/samplePool.service.ts)):
  per item and Sample Store, what the request received on its own linked PO
  lines, less quality-check removals, returns to the supplier and posted notes,
  less what its lines issued (net of returns) and what it closed out. Leftovers
  from round 1 serve round 2. Worked out from the documents every time.
- **Issue** (`MATERIAL`, kind `ISSUE`) only from a Sample Store, capped by the
  pool for bought lines and by the plan for the buyer's own material.
  Sampling rights suffice to issue from a Sample Store.
- **Record use, waste and return** on each line (`MATERIAL` kinds `USE`,
  `WASTE`, `RETURN`). "Held" = issued − used − waste − returned.
- **Not needed** (`WAIVE_MATERIAL`) marks a line not wanted, with a reason,
  before making starts, and can be undone.
- Making cannot start until every line is issued or waived
  (`MATERIAL_NOT_ISSUED`).
- **Leftovers** (`CLOSE_MATERIAL`): once the buyer has decided, a handover
  exists or the request is cancelled, what the request still has in a Sample
  Store is closed out — **used in the sample** (a cost of the sample) or
  **moved to a general store** at the rate it is carried at (needs inventory
  rights). Recorded in `sample_closeouts`.

### Step 5 — Make the sample (Making)

Every step of the route records its pieces **per colour × size cell**, summed
by one ledger ([`packages/shared/src/sampleMaking.ts`](../packages/shared/src/sampleMaking.ts))
that the server checks against and the screen reads.

- **Record work** (`STEP_WORK`): done and rejected per cell, by whom. Done +
  rejected never exceeds what is at the step.
- **Send to the next step** (`STEP_SEND`) and **count in** (`STEP_RECEIVE`),
  with a reason when fewer arrive. Within one department the hand-on is counted
  in at once.
- **Outside step**: **Send to job worker** (`JOB_SEND`) on a challan numbered
  from the `JW` series (printable, `print/sample-job-work`), **Receive back**
  (`JOB_RETURN`) accepted and rejected (never more than was sent), with the
  unit's charge. A challan can be cancelled while nothing has come back.
- **Labour** (`STEP_LABOUR`): ₹ per step, with a note. **A unit's charge**
  (`JOB_CHARGE`) can be corrected when its bill arrives. Both may be recorded on
  any released round until handover, after a cancellation too.
- **Undo** (`MAKING_UNDO`) takes a record back, refused once its pieces have
  moved on.
- Steps run strictly in order. No stock moves at any point.
- A step's `doneQty`, `rejectedQty` and `completedAt` are **written back from
  the ledger** so older readers keep working; they are not edited directly.

### Step 6 — Check, send, and the buyer's word (Quality, Buyer review)

- **QC** (`QC`), colour by colour: the measurement points of the sizes the
  colour finished, read against tolerance (in the order of the measurement
  points), and pieces passed for workmanship size by size. A colour passes when
  every reading is within tolerance and a piece passed. The round is
  `QC_PASSED` if any colour passed, `QC_FAILED` if none did (or nothing
  finished).
- **Dispatch** (`DISPATCH`) on a **Sample Delivery Challan** from the `SDC`
  series (printable, `print/sample-dispatch`): recipient and address (from the
  buyer), mode (courier, by hand, transport), courier and AWB, returnable and
  expected back, declared value or "no commercial value", pieces per cell
  (never more than passed and not yet sent), and the **courier charge**. No
  stock moves. A challan can be cancelled (`DISPATCH_CANCEL`) while nothing on
  the round is decided.
- **The buyer's word** (`DECIDE`), colour by colour, on what was sent:
  approved, changes required (with what to change) or rejected, with who
  decided and the evidence. A colour that will not go on (failed QC, or not
  sent) is **dropped by us** (`DROP_COLOUR`), with a reason — that is our call,
  not the buyer's.
- The round's **verdict** (`roundVerdict`) comes once every colour that passed
  QC has a word: **changes required** if any colour is to be made again
  (changes asked, or failed QC and not dropped); otherwise **approved** if any
  colour was approved (the rest rejected or dropped); otherwise **rejected**.
- **New round** (`NEW_ROUND`, with a reason) carries **only the colours to
  make again** (changes required, or failed QC and not dropped); after an
  approval, for the next milestone, the approved colours; otherwise every colour
  not dropped. Their sizes, measurements and BOM lines come from the last
  round's specification (`coloursToCarry`).
- A **colour status table** shows where each colour of the request stands.

### Step 7 — Cost it (Costing)

- **Other charges** (`ADD_CHARGE`): courier, testing, pattern / CAD,
  embroidery or print setup, other — for one round or for the whole request,
  with a bill reference. Removed with a reason (`REMOVE_CHARGE`), never
  deleted. A challan's courier charge is corrected with `DISPATCH_CHARGE`.
- **The cost sheet** (`sampleCostSheet` in [`packages/shared/src/sampleCost.ts`](../packages/shared/src/sampleCost.ts)),
  per round and for the request:
  - **Material** = (used + waste) × **what this request paid**: the weighted
    rate of its own linked PO lines, weighted by what arrived, after line
    discount and **before GST**. Not the store average (which carries freight
    and other buyers' prices). A line issued from a store before the sample
    was bought for falls back to the store's rate. **The buyer's own material
    is ₹0.** Leftovers closed out as used are material too.
  - **Labour** = each step's labour + each outside unit's charges.
  - **Other** = the charges + the challans' courier charges.
  - Totals, pieces made (from the ledger's last step) and **₹ a piece**.
  - Rounded as a costing sheet is: rates to 4 places, amounts to the paisa at
    each step, so it adds up on a calculator.
- **Finalise** (`FINALISE_COST`, approver) snapshots the sheet on the request.
  It needs: the latest round made (not a draft), every round's steps done
  (a cancelled request is costed as it stopped), no material held on any round,
  and **no leftovers** in the Sample Store (`LEFTOVERS`). While final, nothing
  that changes cost can be recorded (`COST_FINAL`); **Reopen** (`REOPEN_COST`,
  approver, with a reason) clears it.
- **Two prints**: the internal **cost sheet** (`print/sample-cost`, line detail)
  and the buyer's **Sample charges** statement (`print/sample-charges`): buyer,
  their style ref, colours and pieces, material / labour / other, total and a
  piece. It always says it is a statement for information, not a tax invoice;
  it is marked **PROVISIONAL** until the costs are finalised.

### Step 8 — Hand over to bulk (Handover)

Open once every colour of the request has ended (approved, rejected or dropped)
with at least one approved, the latest round is approved or rejected, the costs
are finalised and no material is held.

**Prepare handover** (`HANDOVER`, approver):

- **For each approved colour, its BOM**:
  - **a draft made from the sample** — from the round the colour was approved
    in: the planned quantity a piece and wastage per line, priced at what the
    sample paid (from the finalised cost sheet), the sample's labour and other
    charges a piece as the BOM's labour and overhead lines, and what the sample
    really used a piece written in each line's notes. Version 1.0 for a new
    style, the next whole version for an existing one; or
  - **a BOM Masters has already approved** for that colour or for every colour
    (for a re-sample of an existing style).
- **The style's routing**: one it already has that fits, or one **made from the
  sample's route** (code `RT-<style>`), if every step of that route came from
  the process master.
- **A development style becomes a production style.**
- Drafts are **not approved here**. Masters approves each one in Masters →
  BOMs as it approves any BOM.

**Accept** (`ACCEPT_HANDOVER`, `production:approve`): only once Masters has
approved each colour's BOM — the handover's own draft, or a BOM Masters
approved for that colour after the handover was prepared (a corrected copy).
**No manufacturing order is made.**

After handover the request is frozen: no new round, no cancel, no change to its
details, files, style or costs.

---

## 5. What each phase built

### Phase 0 — Groundwork (`491da69`)

- **Local file storage** for attachments (`STORAGE_DRIVER=local` in
  [`lib/storage.ts`](../apps/api/src/lib/storage.ts), same exports as the
  Supabase driver), active only inside the pilot gate: signed one-use upload
  links, 300-second download links, paths confined to the storage folder,
  50 MB cap, `nosniff`. Served by [`routes/localFiles.routes.ts`](../apps/api/src/routes/localFiles.routes.ts).
- The pilot gate moved to [`lib/pilot.ts`](../apps/api/src/lib/pilot.ts).
- **Merchandiser role** in [`seed-core.ts`](../packages/database/prisma/seed-core.ts):
  sampling view/create/edit/approve/export; purchase view/create/edit;
  dashboard, masters and inventory view. Granted only when the seed makes the
  role, so a hand-made role of that name is never widened.
- **Pilot fixtures** ([`tools/sampling-fixtures.cjs`](../tools/sampling-fixtures.cjs)):
  suppliers, a job worker, processes and departments, a contractor, tax rates,
  number series, a Sample Store and a general store, merchandiser and store
  users. All fictional.

### Phase 1 — Request intake (`81511a2`)

- Request fields: buyer style ref, season, garment category, the request's style.
- `sample_attachments` with ATTACH / DETACH and the keep-once-released rule.
- `Style.stage` (DEVELOPMENT | PRODUCTION, default PRODUCTION); `CREATE_STYLE`,
  `LINK_STYLE`, `UPDATE_STYLE`; development styles refused across sales,
  production and Masters (see step 1).
- Migrations `20261125100300_sampling_intake` (additive) and
  `20261125100400_sampling_request_style_backfill` (data only, pilot rows).

### Phase 2 — Specification (`66d2d7b`)

- Specification v2: colour × size grid, measurements per size, route, BOM
  lines. Older rounds are read through `normaliseSpec`, so every reader sees
  today's shape.
- Sample BOM rows saved from the first draft; route steps from the process
  master checked by the routing rules; quick-add of a material.
- Five-tab specification editor.
- Departments used by sample steps or lines cannot be deleted permanently.
- Migration `20261125100500_sampling_spec_bom_route` (sample tables only).

### Phase 3 — Sourcing (`31834e2`)

- `Warehouse.purpose` (GENERAL | SAMPLING) and the **sample store guard** in
  the one stock writer (`recordMovement`, rules in
  [`lib/sampleStore.ts`](../apps/api/src/lib/sampleStore.ts)): a Sample Store
  is moved only by receipts against orders and their corrections, inspections
  and returns, Sampling's own issues and returns, stock counts, and the buyer's
  own material. Requisitions, transfers, job work, opening stock, stock-in,
  cutting and despatch are refused, naming the store. Requisitions, holds and
  the AI assistant refuse Sample Stores up front; availability, material
  planning and reorder leave sample stock out.
- `PurchaseOrderLine.sampleMaterialId` and `sampleOverReason`, with the link
  rules in step 3.
- Needs (`GET /sampling/needs`, `GET /purchase/sample-needs`), the Sourcing
  section, "Raise purchase order", "Select from sample needs", sample labels on
  order lines, receipt store choices by line, and what a store holds in Masters.
- Migration `20261125100600_sampling_sourcing` (additive).

### Phase 4 — The request's pool (`ccc0ce8`)

- `samplePool.service`: the pool, worked out from documents (step 4).
- Issue only from a Sample Store, capped by the pool; the database CHECK
  `issuedQty <= plannedQty` dropped in favour of this rule.
- `WAIVE_MATERIAL`, `CLOSE_MATERIAL`, `sample_closeouts`.
- **Guards on purchase documents**: cancelling, correcting or deleting a
  receipt, quality checks, returns to the supplier and posting notes **lock the
  samples whose material they touch and refuse to leave a sample having issued
  more than it holds** (`assertPoolsHold`).
- The stock ledger and stock reports name a sample's movements by request and
  buyer (`movementDocs.service`, `inventory-shared` report bucket).
- Migration `20261125100700_sampling_pool` (sample tables only).

### Phase 5 — Making (`2f78836`)

- The shared making ledger; `sampleMaking.service` with `STEP_WORK`,
  `STEP_SEND`, `STEP_RECEIVE`, `JOB_SEND`, `JOB_RETURN`, `STEP_LABOUR`,
  `JOB_CHARGE`, `MAKING_UNDO`; the job-work challan print.
- Rejection in a multi-colour or multi-size round is now allowed (the first
  pilot could not).
- A line is no longer waived once making starts; a request with pieces still
  at an outside unit cannot be cancelled (`PIECES_OUT`).
- Migration `20261125100800_sampling_making`: `sample_works`,
  `sample_transfers`, `sample_job_works`, `sample_job_returns`, labour on
  steps; steps recorded whole before are marked `wholeStep`.

### Phase 6 — QC, dispatch, decision (`992edd8`)

- QC per colour and the `QC_FAILED` state; `sample_dispatches` (Sample
  Delivery Challan, `SDC` series, print); `DECIDE` per colour and
  `DROP_COLOUR`; the round's verdict; `NEW_ROUND` carrying only the colours to
  make again; handover readiness per request (`handoverReady`).
- Rounds inspected, submitted and decided whole before this are read in the new
  shape (`normaliseQc`, `normaliseDecision` in
  [`packages/shared/src/sampleReview.ts`](../packages/shared/src/sampleReview.ts)).
- Migration `20261125100900_sampling_review`: `sample_dispatches`, the state
  CHECKs widened for `QC_FAILED`, and the `SDC` number series inserted for every
  company (inert until used, like `SAMPLE`).

### Phase 7 — Costing (`51a7e04`)

- `sample_charges`; the shared cost sheet; `sampleCost.service` with
  `ADD_CHARGE`, `REMOVE_CHARGE`, `DISPATCH_CHARGE`, `FINALISE_COST`,
  `REOPEN_COST` and the cost lock; the Costing section; the internal cost sheet
  and the buyer's Sample charges statement (print types `SCOST` and `SCS`).
- Handover now waits for finalised costs (`COST_NOT_FINAL`).
- Migration `20261125101000_sampling_cost`: `costSheet`, `costFinalisedAt`,
  `costFinalisedBy` on `sample_requests` (CHECK: all set or none), and
  `sample_charges` (CHECK on kind, amount > 0, and removal with a reason).

### Phase 8 — Handover (`f2f617b`)

- `sampleHandover.service` with `HANDOVER` and `ACCEPT_HANDOVER` as in step 8.
- **BOM arithmetic moved, unchanged, out of `master.routes.ts`** into
  [`services/bom.service.ts`](../apps/api/src/services/bom.service.ts)
  (`priceBomLines`, `costBom`, `assertVersionFree`, `toLineCreate`,
  `rethrowVersionClash`, now taking the database or transaction to work in),
  so the handover prices BOMs exactly as Masters does, inside its own
  transaction. Masters calls them as before. `nextBomVersion` added.
- Shared [`sampleHandover.ts`](../packages/shared/src/sampleHandover.ts):
  which round each colour was approved in, the draft BOM's lines, its labour
  and overhead lines.
- The Handover section rebuilt ([`SampleHandover.tsx`](../apps/web/src/components/sampling/SampleHandover.tsx)).
- No migration: the handover is kept as JSON on the round.

---

## 6. Where the code is

### API (`apps/api/src`)

| File | What it does |
|---|---|
| [`routes/sampling.routes.ts`](../apps/api/src/routes/sampling.routes.ts) | All `/sampling` endpoints behind the pilot gate; `visible()` strips money by role; prints' data |
| [`services/sampling.service.ts`](../apps/api/src/services/sampling.service.ts) | `actOnSample` (the one door), `sampleDetail`, lookups, specification validation, release, material, waive, close-out, new round, cancel, files, style actions |
| [`services/sampleSourcing.service.ts`](../apps/api/src/services/sampleSourcing.service.ts) | Needs, PO-line link rules, ordered/received sums |
| [`services/samplePool.service.ts`](../apps/api/src/services/samplePool.service.ts) | The request's pool; `assertPoolsHold` for purchase documents |
| [`services/sampleMaking.service.ts`](../apps/api/src/services/sampleMaking.service.ts) | Making actions; rollups written back to steps |
| [`services/sampleReview.service.ts`](../apps/api/src/services/sampleReview.service.ts) | QC, dispatch, dispatch cancel, decide, drop colour |
| [`services/sampleCost.service.ts`](../apps/api/src/services/sampleCost.service.ts) | Charges, cost sheet from the database, finalise, reopen, `changesCost` |
| [`services/sampleHandover.service.ts`](../apps/api/src/services/sampleHandover.service.ts) | Handover and acceptance; where each colour's BOM stands; handover without figures |
| [`services/bom.service.ts`](../apps/api/src/services/bom.service.ts) | BOM pricing, costing, version guard (shared with Masters) |
| [`schemas/sampling.schemas.ts`](../apps/api/src/schemas/sampling.schemas.ts) | Every action's input, with plain-word messages |
| [`lib/sampleStore.ts`](../apps/api/src/lib/sampleStore.ts) | What may move a Sample Store |
| [`lib/styleStage.ts`](../apps/api/src/lib/styleStage.ts) | The development-style refusal, used everywhere |
| [`lib/pilot.ts`](../apps/api/src/lib/pilot.ts) | The pilot gate |
| [`lib/storage.ts`](../apps/api/src/lib/storage.ts), [`routes/localFiles.routes.ts`](../apps/api/src/routes/localFiles.routes.ts) | Local file storage for the pilot |
| [`lib/itemMaster.ts`](../apps/api/src/lib/itemMaster.ts) | Item validation shared by Masters and the BOM grid's quick-add |

Endpoints (all under `/api/sampling`, all behind the gate): `GET /lookups`,
`GET /needs`, `GET /route-template`, `GET /items/search`, `POST /items`,
`GET /` (register), `POST /` (new request), `GET /:id`, `POST /:id/actions`,
`GET /:id/print`, `GET /:id/cost`, `GET /:id/cost/print?kind=sheet|charges`,
`GET /job-work/:jobId/print`, `GET /dispatch/:dispatchId/print`, the file
endpoints (`/:id/attachments`, upload link, download link), `GET /:id/routings`,
`GET /:id/routings/:routingId/steps`.

### Web (`apps/web/src`)

| File | What it does |
|---|---|
| `app/(dashboard)/sampling/page.tsx` | The register |
| `components/sampling/SampleWorkspace.tsx` | The workspace: sections, material preparation, buyer review wiring |
| `components/sampling/samplingFlow.ts` | "What to do now", section completion, history wording, material actions, issue caps, close-out and finalise blockers |
| `components/sampling/SampleSpecEditor.tsx`, `spec/*Tab.tsx`, `specRules.ts` | The five-tab specification editor and its rules |
| `components/sampling/SampleRequestEditor.tsx`, `SampleFiles.tsx`, `SampleStyleCard.tsx` | Brief, files, the request's style |
| `components/sampling/SampleMaking.tsx` | Making: steps, windows for work, send, receive, job work, labour, undo |
| `components/sampling/SampleReview.tsx` | QC, dispatch, decisions |
| `components/sampling/SampleCost.tsx` | Costing: charges, cost sheet, finalise / reopen |
| `components/sampling/SampleHandover.tsx` | Handover: what will be made, the prepare window, the record and acceptance |
| `components/sampling/types.ts` | The request as the screen receives it |
| `components/purchase/SampleNeedsDialog.tsx`, `sampleLines.ts` | "Select from sample needs" in the purchase order form |
| `app/(print)/print/sample/[id]` | The sample record print |
| `app/(print)/print/sample-job-work/[id]`, `sample-dispatch/[id]`, `sample-cost/[id]`, `sample-charges/[id]` | Job-work challan, Sample Delivery Challan, cost sheet, Sample charges statement |

### Shared (`packages/shared/src`)

| File | What it holds |
|---|---|
| `sampling.ts` | Specification shape, `normaliseSpec`, required quantity, gaps, states and labels |
| `sampleMaking.ts` | The making ledger (`makingLedger`), cells, outstanding job work |
| `sampleReview.ts` | Colour outcomes, round verdict, request colours, `handoverReady`, QC/decision normalising |
| `sampleCost.ts` | `sampleCostSheet`, `purchaseRate`, charge kinds |
| `sampleHandover.ts` | `approvedFrom`, `handoverBomLines`, `handoverCostLines`, snapshot types |

### Data

Sample tables (all `sample_*`, schema `ld_erp`):

| Table | Holds |
|---|---|
| `sample_requests` | The request; state, version, cancellation; the finalised cost sheet |
| `sample_rounds` | Revision, state, `specification` (JSON), `qc`, `submission` (older), `decision` (per colour), `handover` (JSON) |
| `sample_materials` | Sample BOM lines with issued / used / waste / returned quantities and values, waive |
| `sample_stages` | Route steps; rollups written back from the ledger; labour |
| `sample_works`, `sample_transfers` | Work recorded per cell; hand-ons between steps |
| `sample_job_works`, `sample_job_returns` | Outside-unit challans and what came back, with charges |
| `sample_dispatches` | Sample Delivery Challans |
| `sample_charges` | Other charges |
| `sample_closeouts` | Leftovers closed out |
| `sample_events` | Every action, in order (the History section) |
| `sample_attachments` | Files |

Columns added to existing tables: `styles.stage`, `warehouses.purpose`,
`purchase_order_lines.sampleMaterialId` and `sampleOverReason`. Rows added:
the Merchandiser role (seed), the `SDC` number series (migration and seed).

Eleven migrations, all hand-written and additive: the old pilot's three, then
the rebuild's eight. They were written 14–21 Nov and renamed to 25 Nov when
`main` was merged in, so they sort after `main`'s own (the newest then was
`20261124160000_fg_cartons`): a fresh database applies them in the order the
shared one will. Their contents did not change.

| Migration | Changes |
|---|---|
| `20261125100000_sampling_pilot` | The sample tables: requests, rounds, stages, materials, events |
| `20261125100100_sampling_list_state` | `sample_requests.state` for the register; sampling permissions |
| `20261125100200_sampling_numbering_and_guards` | `SAMPLE` number series; non-negative and state CHECKs |
| `20261125100300_sampling_intake` | `sample_attachments`; request fields; `styles.stage` |
| `20261125100400_sampling_request_style_backfill` | Data only (pilot rows) |
| `20261125100500_sampling_spec_bom_route` | BOM-line and route-step columns on sample tables |
| `20261125100600_sampling_sourcing` | `warehouses.purpose`; PO-line link |
| `20261125100700_sampling_pool` | `sample_closeouts`; waive columns; drops `issued <= planned` |
| `20261125100800_sampling_making` | Works, transfers, job works and returns; labour |
| `20261125100900_sampling_review` | `sample_dispatches`; state CHECKs for `QC_FAILED`; `SDC` series |
| `20261125101000_sampling_cost` | Cost columns; `sample_charges` |

### Numbers and prints

| Series / print type | Used for |
|---|---|
| `SAMPLE` | Request number (`SMP-…`) |
| `JW` | Sample job-work challan (the existing job-work series, shared with GST challans) |
| `SDC` | Sample Delivery Challan |
| Print types `SDC`, `SCS`, `SCOST` | Titles via `getPrintHeader`. `SDC` and `SCS` have editable templates in Settings (listed only while sampling is on); `SCOST` uses its default title |

### Tools (`tools/`)

`sampling-local.ps1` (the pilot launcher), `sampling-fixtures.cjs` (pilot
masters), `register-ts.cjs` (runs TypeScript in check scripts), and the check
scripts in [section 11](#11-the-runnable-checks).

---

## 7. Every action, who may do it, what it checks

| Action | Permission | Family | In short |
|---|---|---|---|
| `SAVE_DRAFT`, `SAVE_SPEC` | sampling:edit | sampling | Save the draft specification |
| `UPDATE_REQUEST` | sampling:edit | sampling | Change the brief; buyer and brand lock after the first release |
| `RELEASE` | **sampling:approve** | sampling | Validate and freeze the specification; make BOM and route rows |
| `ATTACH`, `DETACH` | sampling:edit | sampling | Files |
| `CREATE_STYLE`, `LINK_STYLE`, `UPDATE_STYLE` | sampling:edit | sampling | The request's style |
| `MATERIAL` | sampling:edit | sampling | Issue / use / waste / return on a line (any round) |
| `WAIVE_MATERIAL` | sampling:edit | sampling | Line not needed (or needed again) before making |
| `CLOSE_MATERIAL` | sampling:edit (+ inventory:edit to move) | sampling | Leftovers used or moved |
| `STEP_WORK`, `STEP_SEND`, `STEP_RECEIVE` | sampling:edit | making | Pieces per cell |
| `JOB_SEND`, `JOB_RETURN` | sampling:edit | making | Outside unit |
| `STEP_LABOUR`, `JOB_CHARGE` | sampling:edit | making | Labour and unit charges (any released round, after cancel too) |
| `MAKING_UNDO` | sampling:edit | making | Take a record back |
| `QC` | **sampling:approve** | review | QC per colour |
| `DISPATCH`, `DISPATCH_CANCEL` | sampling:edit | review | Sample Delivery Challan |
| `DECIDE` | **sampling:approve** | review | The buyer's word per colour |
| `DROP_COLOUR` | **sampling:approve** | review | Our decision not to go on with a colour |
| `NEW_ROUND` | sampling:edit | sampling | Next round, colours to make again |
| `ADD_CHARGE`, `REMOVE_CHARGE`, `DISPATCH_CHARGE` | sampling:edit | cost | Other charges, courier corrections |
| `FINALISE_COST`, `REOPEN_COST` | **sampling:approve** | cost | Freeze / unfreeze the costs |
| `HANDOVER` | **sampling:approve** | handover | Draft BOMs, routing, style made production |
| `ACCEPT_HANDOVER` | sampling:edit + **production:approve** | handover | Production takes it |
| `CANCEL` | **sampling:approve** | sampling | Cancel with a reason; refused with pieces out or material held, or after handover |

Creating a request needs `sampling:create`; viewing needs `sampling:view`.

**Who sees money** (`visible()` in the route, and the same rule on the screens):

| Figure | Seen by |
|---|---|
| Material values (issued, returned, close-out values) | accounts:view |
| Step labour, unit charges, courier charges, other charges | sampling:edit or accounts:view |
| The cost sheet, finalised totals, the handover's rates and costs | sampling:approve or accounts:view |

Events lose their amounts for those who may not see them; the register carries
only whether a handover is prepared and accepted.

**After a cancellation** only these are taken: `CLOSE_MATERIAL`,
`STEP_LABOUR`, `JOB_CHARGE` and the cost actions (bills arrive after a sample
is dropped).

**While the costs are final** these are refused (`COST_FINAL`): `MATERIAL`,
`NEW_ROUND`, every making action, the charge actions, `CLOSE_MATERIAL` as used,
`DISPATCH` with a courier charge, and cancelling a challan that carried a
courier charge.

---

## 8. Rules worth knowing before you change anything

1. **Never write sample data outside `actOnSample`.** Every action needs the
   row lock, the version check, the gates and the history event. A new action
   is added to the schema's enum, to `actOnSample` (or a family service), and,
   if it is an approver's call, to the approver list.
2. **Shared rules live in `packages/shared`.** If the server and the screen
   both need a calculation, write it there once. Do not copy it into a
   component.
3. **The pool is never stored.** It is summed from documents. If you add a
   document that moves material bought for a sample, teach
   `samplePool.service` about it and make it lock and check the affected
   requests (`assertPoolsHold`) as receipts, QC, returns and notes do.
4. **A Sample Store is moved only by the documents in `lib/sampleStore.ts`.**
   The check is in the one stock writer, so it holds whatever screen asks. A
   new stock document is refused there until it is added on purpose.
5. **The specification is frozen at release.** Change comes through a new
   round. Old specifications, QC and decisions are read through the
   `normalise…` functions; keep them working when you change a shape.
6. **Step rollups come from the ledger.** `doneQty`, `rejectedQty`,
   `completedAt` on `sample_stages` are written back by `syncMaking`; never
   set them by hand.
7. **A development style must stay out of production and sales** until
   handover. Any new place that turns a style into an order, BOM, route, MO,
   finished stock or a tag must call `assertStylesInProduction` /
   `styleInDevelopment`.
8. **Material is costed at what the request paid**, weighted by what arrived,
   after line discount and before GST — not the store average. The buyer's own
   material is ₹0. Order-level discount and freight are not spread into it.
9. **Finalised costs are a snapshot.** Anything that changes cost must be added
   to `changesCost` so the lock covers it.
10. **The handover makes drafts, never approvals.** Masters stays the place a
    BOM is approved (and approving makes the older approved BOM of that colour
    obsolete). Acceptance waits for those approvals; a BOM approved before the
    handover never stands in for the sample's draft.
11. **BOM arithmetic is in `bom.service.ts`**, used by Masters and the
    handover. Change it there, once.
12. **Numbers come from `nextDocumentNumber()`** (`SAMPLE`, `JW`, `SDC`). A new
    series needs a row in the seed and a migration insert for existing
    companies; numbers stay within 16 characters.
13. **Money by role** (section 7). A new figure on the request must be stripped
    in `visible()` for those who may not see it, including inside events and
    JSON snapshots.

---

## 9. Other modules: used and changed

| Module | What sampling uses | What changed in it |
|---|---|---|
| **Masters** | Styles, items, processes (operations), departments, contractors, suppliers as job workers, routings, BOMs and their approval, style codes | Development styles refused for BOMs and routings, and their brand, size run and colours locked from Masters while in sampling; "Development" badge and filter on Styles; store purpose on Warehouses and what a store holds; item quick-add rules shared (`lib/itemMaster.ts`); **BOM pricing, costing and version guard moved to `bom.service.ts`, behaviour unchanged**; departments used by samples cannot be deleted permanently |
| **Purchase** | The normal purchase order form and receipts | PO-line link to a sample line and its rules; "Select from sample needs"; sample labels on lines; over-order reason; receipts put sample lines only into a Sample Store; receipt cancel / correct / delete, GRN quality checks, returns to the supplier and posted notes lock and check the affected samples |
| **Inventory** | The stock writer, the ledger | Sample Store guard in `recordMovement`; requisitions, holds, transfers, job work, opening stock, stock-in, cutting and despatch refuse Sample Stores; availability, material planning and reorder leave sample stock out; the ledger and reports name sample movements by request and buyer |
| **Sales** | — | Sales orders and quotations refuse development styles (also when the style is typed as a code) |
| **Production** | Nothing of its engine | MOs, finished-goods receipts and garment tags refuse development styles; the routings overview does not wait for a route for a style in sampling |
| **Settings** | Print header and templates | `SDC` and `SCS` print types (pilot-gated); `SCOST` title |
| **Seed / numbering** | `nextDocumentNumber`, the `JW` series | Merchandiser role; `SDC` series |
| **AI assistant** | — | Its write tools refuse Sample Stores |
| **Accounts, GST invoices, the MO engine** | — | **Not touched.** Posting sample cost to a ledger and a GST invoice for sample charges are left for later |

In all, 107 files changed on the branch, 47 of them existing files outside
sampling (the rest are new sampling files, migrations and check scripts).

---

## 10. Running it on your machine

Everything below uses the isolated pilot. It never touches the shared database.

```powershell
# From the repository root. Needs PostgreSQL 16 installed (C:\Program Files\PostgreSQL\16\bin, or PG_BIN).
powershell -NoProfile -ExecutionPolicy Bypass -File tools/sampling-local.ps1 -Action Prepare   # rebuild DB + fixtures
powershell -NoProfile -ExecutionPolicy Bypass -File tools/sampling-local.ps1 -Action Start     # API :5102, web :3302
powershell -NoProfile -ExecutionPolicy Bypass -File tools/sampling-local.ps1 -Action Stop
```

- Database `lderp_sampling` on `127.0.0.1:55439`; API on port 5102; web at
  `http://localhost:3302/sampling`. The fictional logins are made by
  `tools/sampling-fixtures.cjs`.
- Uploaded files stay in `.local-sampling/files` on this machine.
- Prepare applies every migration with `migrate deploy` and loads the fixtures.
  It refuses to run while a pilot session is started; Stop first.

**Type checks** (there is no `tsc` inside the app folders):

```powershell
cd apps/api; node ../../node_modules/typescript/bin/tsc --noEmit
cd apps/web; node ../../node_modules/typescript/bin/tsc --noEmit
```

**Fresh-chain migration test** (on the same isolated cluster): create
`lderp_sampling_fresh` on `127.0.0.1:55439`, set `DATABASE_URL` and `DIRECT_URL`
to it **in the same command**, run
`node node_modules/prisma/build/index.js migrate deploy --schema packages/database/prisma/schema.prisma`,
then `migrate diff --from-url <it> --to-schema-datamodel packages/database/prisma/schema.prisma --script`,
then drop the scratch database. The only acceptable output is the drift that
was there before this work (see [Traps](#12-traps)).

---

## 11. The runnable checks

Run from the repository root with the pilot database up. Each asserts it is on
`lderp_sampling`, works through the real routes over HTTP, and leaves its rows
in the pilot (Prepare clears them).

| Script | Passing | Covers |
|---|---|---|
| `node tools/check-sampling.cjs` | 453 | The whole request life: intake, files, styles, specification, release, sourcing link, issue, making, QC, dispatch, decisions, new rounds, costs before handover, handover with an approved BOM, cancellation, permissions, stale-version refusals, money visibility |
| `node tools/check-sample-sourcing.cjs` | 23 | PO-line link rules, needs, receipts into Sample Stores, carry-through on PO edit |
| `node tools/check-sample-pool.cjs` | 11 | The pool from documents; purchase documents that would leave a sample short |
| `node tools/check-sample-making.cjs` | 22 | Per-cell arithmetic, transfers, outside units, labour, undo |
| `node tools/check-sample-review.cjs` | 10 | QC per colour, challans, decisions, drops, carrying colours to the next round |
| `node tools/check-sample-cost.cjs` | 7 | Cost sheet figures, finalise conditions, the cost lock, reopen, cancelled costing, prints |
| `node tools/check-sample-handover.cjs` | 10 | A new style end to end: promotion, routing from the route, draft BOMs priced from the costs, Masters approval, acceptance, no MO; Masters BOM regression after the move to `bom.service` |
| `node tools/check-sampling-ui.cjs` | 96 | The screens' rules: flow and sections, material actions, cost and handover arithmetic, history wording |
| `node tools/check-local-storage.cjs` | 74 | Local file storage and the pilot gate (no database) |

The shared-module regressions, run on 25 November after `main` was merged in,
against a scratch database on the pilot cluster seeded with `seed.ts` and
`seed-demo.ts` (the demo database was not running), the built API on port
5000 with Sampling off — as the live server will be the day it merges:

| Check | Result | On `main`'s own code, same data |
|---|---|---|
| `check-grn.mjs` | 14 passed, 6 failed | the same 14 and the same 6 |
| `check-stock-documents.mjs` | 20 passed, 1 failed | the same |
| `check-job-work.mjs` | 9 passed, 5 failed | the same |
| `check-purchase-pricing.ts` | 18 passed | — |
| `check-accounts-posting.ts` | 7 passed (rolled back) | — |

The failures are the same check for check on `main` without sampling, so
they are those scripts lagging behind `main` (a receipt's rejections moved to
QC, for one), not this branch. The API build (`scripts/build.cjs`, which now
loads the shared package's compiled copy) and `next build` both pass. The
e2e walk (steps 09–14) was not run: it needs the demo database, which copies
masters from the live one.

---

## 12. Traps

- **`apps/api/.env` is the live shared database.** Nothing in this work may run
  against it. Use the launcher or a scratch database on `127.0.0.1:55439`.
- **Prepare can appear to hang when started from another tool** (the pilot's
  Postgres inherits the output handle). Send its output to a log; it is done
  when the log ends with "Local fixtures ready".
- **After an unclean shutdown**, `.local-sampling/processes.json` and
  `.local-sampling/data/postmaster.pid` go stale and block Prepare. Stop clears
  the first; remove the second only after confirming its process is dead and
  nothing listens on 55439. The Windows service `postgresql-x64-16` is not the
  pilot.
- **While the pilot is running**, `prisma generate` fails renaming the query
  engine DLL (the files it needs are still written). Stop the pilot first if
  you need a clean generate.
- **Known migration drift that is not ours**: the foreign keys on
  `purchase_order_lines.shortClosedById` and `supplier_payments.reversedById`,
  and the default on `grn_lines.packQtys`. Anything else in the fresh-chain
  diff is new and must be explained.
- **Two handover shapes.** Handovers prepared before phase 8 hold one linked
  BOM (`bomId`, `bomVersion`, `routingId`, `routingVersion`); since phase 8
  they hold `style`, `boms[]`, `routing`, `cost`, `approvedIn[]` and, once
  accepted, `accepted[]`. Every reader (screen, print, acceptance) handles
  both.
- **Draft BOMs carry sample-sized labour and charges a piece** (e.g. ₹300
  labour, ₹50 courier a piece). Masters must adjust them before approving.
- **Buyer-supplied sample lines are not marked `customerSupplied` on the draft
  BOM**, deliberately: production reads that flag to treat material as the
  customer's own on every order, and a buyer sending a sample trim says nothing
  about bulk. The line's notes say so; Masters prices it.
- **Leftovers block finalising before the buyer decides.** Leftovers are kept
  for a next round until the buyer has decided, and costs cannot be finalised
  while any are in the store. The provisional statement still prints.
- **A colour with no material lines cannot be handed over for a style made in
  sampling** (no BOM can be made, and Masters forbids one for a development
  style). Add its material in a new round.
- **The pool's known limits**: one store per sample line (a line with nothing
  out may switch store); a stock-count shortfall in a shared Sample Store is not
  attributed to a request; `available` floors at 0.
- **A customer receipt may put any of the buyer's own material into a Sample
  Store** (allowed for customer-owned stock). Tighten it if it is misused.
- **The seed's comment on the Merchandiser role is out of date**: it says
  issuing sample material needs inventory edit. Since phase 4, sampling rights
  issue from a Sample Store. The grants themselves are right; fix the comment
  when next touching the seed.
- **The register cannot show colours or pieces**: the list endpoint sends no
  specification.
- **Expected rates on BOM lines (`estRate`) are visible to every sampling
  viewer.** Left as it was; decide whether to hide them.

---

## 13. What is left before switching it on

**Merging.** The pull request carries the eleven migrations (see
[MIGRATION-NOTES.md](../MIGRATION-NOTES.md), 25 Nov entry). The team rule
holds: tell the team, apply them to the shared database with
`prisma migrate deploy` and merge on the same day. Merged and migrated,
nothing changes for anyone until Sampling is switched on.

**Switching it on in live**, when the business is ready:

1. API server (Render): `SAMPLING_ENABLED=true`. Web (Vercel):
   `NEXT_PUBLIC_SAMPLING_ENABLED=true`, then redeploy — the screens read it at
   build time. Leave `STORAGE_DRIVER` alone; files go to the bucket as
   everyone else's do.
2. Masters → Warehouses: a Sample Store, purpose Sampling.
3. Settings: a Merchandiser role with the rights `seed-core.ts` gives it (the
   seed is never run against the shared database, so it is made by hand), and
   its users. The sampling permissions themselves come with the migrations.
4. Settings → Number series: `SAMPLE` and `SDC` are there from the
   migrations; check their prefixes.

**Still open:**

1. **Phase 3 leftovers**:
   - on a purchase order that has both indent lines and sample lines, the
     indent reference and the sample reference overwrite each other;
   - the "+ another store" button on a receipt is a dead end when there is only
     one Sample Store;
   - the reason box when an order line is reopened.
2. **The e2e walk, steps 09–14**, on the demo database (see the end of
   [section 11](#11-the-runnable-checks)).
3. **Merchandiser testing** with a real tech pack, in light mode, at narrow
   width and with the keyboard — on the pilot, or on the live server once
   switched on for a trial.

---

## 14. Open questions

**For the CA**

- The wording on the sample **job-work challan**, and whether sample job work
  must appear in **ITC-04**.
- The wording on the **Sample Delivery Challan** ("no commercial value",
  returnable).
- The wording on the **Sample charges** statement. If money is actually
  collected for sample charges, GST needs a sales invoice; a challan-less
  invoice path is not built (invoices need a delivery challan today).
- Whether input GST on sample purchases is always recoverable (the cost sheet
  assumes so and excludes GST).

**For the project owner**

- Should preparing a handover need Masters rights as well as sampling approval?
  Today sampling approval alone makes the draft BOMs and routing (Masters still
  approves the BOMs before anything uses them).
- Should draft BOMs carry the sample's labour and charges a piece, or start
  with none?
- Should expected rates be hidden from sampling viewers without approval?

**Later (not planned in detail)**

- Purchase enquiries with quotes for sample material.
- Sample job work in ITC-04, after the CA confirms.
- A GST invoice for sample charges; posting sample cost to a "Sampling &
  development" ledger.
- Register additions: overdue flag, sourcing progress, cost total; dashboard
  tiles.

---

## 15. Where to start

1. Read [section 1](#1-the-one-thing-to-understand-first) and
   `actOnSample` in [`sampling.service.ts`](../apps/api/src/services/sampling.service.ts).
2. Run the pilot (section 10), log in, and walk one request from the Brief to
   the Handover with the "What to do now" box.
3. Read the shared files in `packages/shared/src/sample*.ts`: they are the
   rules, in the order the process runs.
4. Run every check in section 11. All should pass before you change anything,
   and after.
5. For a change in one stage, open that stage's service and its check script
   together; for anything that touches stock, purchase or Masters, read
   [section 9](#9-other-modules-used-and-changed) and section 8's rules 3, 4, 7
   and 11 first.
