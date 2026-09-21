# Business processes

What actually happens at LD Cotton Mills, module by module — as opposed to
[Business rules](04-business-rules.md), which is the fixed rules (numbering,
GST, stock, money) that apply *across* every process below. Read that file for
the things that must never break. Read this one for the sequence of events
that produces the documents those rules govern.

Built from: a read-through of the mill's old system, Absolute ERP (24 Aug
2026); a traced live example of the purchase chain (18 Sep 2026); and design
and test documents for VHAGAR, the goods-return system, HR, and three
sales/lead systems. Sources are listed at the bottom. Where something is
still an open question for the business to answer, it says so — nothing
below is invented to fill a gap.

**A word on how sure to be about any of this.** The purchase chain was
traced on a real document (PO-0514 → GRN-0480 → Bill 777/2627) and is solid.
The sales/lead section is not — three or four systems were found with
different names and no document says how they relate. Treat that section as
"what exists," not "what to build."

---

## 1. The company family

| Name | What it is | GST | Modelled in the ERP as |
|---|---|---|---|
| **LD Cotton Mills** | The garment manufacturer this ERP is for. Bhiwandi. | Own GSTIN | The company |
| **LD Silk Mills** | Sister company, same ownership, supplies fabric to LD Cotton Mills. | Own, separate GSTIN | A supplier, flagged `isGroupCompany` — [never a second company in this database](04-business-rules.md#10-one-company-per-database) |
| **Linkd Prints** | A third entity — digital print business. Appears in LD Silk Mills' sales register (its `comp` column) and in SCOT (§6) as "LinkD," sharing SCOT's infrastructure with LD. | Unconfirmed | Not modelled yet — **open question, see §11** |
| **VHAGAR** | A separate garment production-and-traceability operation with its own app, currently single-tenant. Not clearly a retail/D2C brand — the evidence is manufacturing and QC, not a storefront. | — | Not connected to this ERP at all yet — see §5 |

LD Silk Mills is LD Cotton Mills' single largest creditor in the old
system's books — ₹1,75,76,855 owed as of 31 Mar 2025, plus a separate
₹1,20,00,000 loan account. Whatever fabric-supply relationship exists
between the two runs through real invoiced purchases, not an internal
transfer.

The old system, Absolute ERP, was bought, not built — 19 months of use
before this project started. The teardown's verdict on it: **"Absolute is
your invoicing and purchasing machine. Nothing else."** Document counters
from that account, which is the closest thing to a census of what the mill
actually does on paper:

| Document | Count |
|---|---|
| Purchase orders | 443 |
| Goods receipts | 400 |
| Job-work receipts | 209 |
| Sales invoices | 192 |
| Sales orders | 31 |
| Credit notes | 21 |
| Debit notes | 18 |
| Delivery challans | 9 |
| Quotations / Estimations / Proforma | 1 each — never used |

Purchase and receiving are where the volume is. Job work is a real, heavy
process (209 receipts) with no home in this ERP yet. Sales, on this
evidence, runs mostly outside Absolute — see §6.

---

## 2. Purchase — indent to payment

This is the one process traced end to end on a live document, and the one
already substantially built. The full chain, old system's terms:

```
Indent Requisition → Provisional PO → Supplier Rates → Purchase Order
  → GRN → QC → Bill from GRN → Payment → Debit Note
```

| # | Stage | Old system states | Built here? |
|---|---|---|---|
| 1 | Indent Requisition — a department asks for something | PO Pending → PO Created | No |
| 2 | Provisional PO — an enquiry, its own Enquiry No, sent to suppliers | — | No |
| 3 | Supplier Rates — rates come back against the enquiry, compared | — | No |
| 4 | **Purchase Order** | Open/Approve → Partially Billed → Billed | **Yes** |
| 5 | **Goods receipt (GRN)** | — | **Yes** |
| 6 | QC on the GRN — approve/reject quantity, reason, per line | — | Yes, on one screen with receiving — see below |
| 7 | **Bill from GRN** — tick several GRNs, one bill | — | **Yes** |
| 8 | **Purchase Invoice** — carries supplier's own invoice number | — | **Yes** |
| 9 | **Payment** | Partially Paid → Fully Paid | **No — the one 501 left in Purchase** |
| 10 | Debit Note — returns, rate differences | — | No |

Also on the old menu, not part of the numbered chain: PO without Price,
Credit Notes, DC Returnable, DC Non-Returnable.

**Traced real example**, proving the chain holds together:

> PO-0514 · 02/09 · ₹6,279 → GRN-0480 · 18/09 → Challan 1872–1887 · 02/09 →
> QC pending → Bill 777/2627 · ref GRN-0480 → Due 19/10 · unpaid

Read off that: one PO can spawn many challans (16, in this case — 1872 to
1887); a GRN typically lags the order by about two weeks; the **bill's
reference is the GRN, not the PO**; and a due date is tracked separately
from payment status.

### The three kinds of GRN — only one is Purchase

| GRN type | Against | Goods arrive from | Belongs to | Status |
|---|---|---|---|---|
| **Purchase Order GRN** | A purchase order | A supplier — goods we bought | Purchase | **Built** |
| **Job Work GRN** | A job-work order | A job worker — our own material, processed, back | Production ("MO Job work") | Not built |
| **GRN JW Customer** | A sales order | A customer — their material, for us to work on | Sales ("Customer GRN") | Not built |

A fourth, related path: **DC Returnable** — material sent out to a vendor
against a PO, carrying a lorry receipt number, with its own column for when
it returns. No records existed in it when read.

### What the receiving screen actually holds

The old form is titled **"Purchase Order GRN Items Receive."** Supplier,
order number, item list and rates are all inherited from the PO — this
screen is only about the delivery itself.

**Header fields** — 14 of them beyond GRN number/date/order/vehicle/remark,
all now on the `grn` table: time of receipt, gate entry number and date,
challan number and date, supplier bill number, supplier invoice number and
date, number of packages, driver name, form no, client name, ordered by,
reference no, attachments.

**Item grid** — four quantity columns per PO line: PO Quantity (locked),
Received Quantity so far (locked), **Receive Quantity** (editable, split
across warehouses, rows addable), and Rate/Amount/GST% carried from the
order for valuation only. **There is no totals block on the entry
screen at all** — no discount, no transport, no tax summary — because
"the money was settled on the order." The *printed* GRN does show those
totals, pulled from the PO at print time.

The printed Goods Receipt Note: three header blocks (supplier with GSTIN;
the receipt itself with gate entry and challan; the invoice with its PO
reference), item columns S.N/Item Code/Description/UOM/Quantity/Rate/
Discount/Amount, amount in words, and three signature lines — **Prepared
By, Inspected By, Authorized By.** A "Print Roll Barcode" button exists
specifically for received fabric rolls.

### Receiving and billing — the rules, as the business states them

**The core principle: physical receiving (GRN) and financial accounting
(Purchase Bill) are two separate steps.** Goods arrive on a truck with a
delivery challan long before the supplier sends a tax invoice. Wait for the
invoice before recording stock and production stalls; record stock from
invoices and the warehouse count never matches physical reality.

**The rule for creating receipts: one delivery challan = one GRN.** Every
time a vehicle arrives at the gate, one GRN is raised against that specific
challan. Suppliers ship lots as fabric becomes available and invoice
weekly or monthly, so a receipt per delivery is what keeps stock accurate.

#### The five line outcomes on any receipt

The system compares ordered quantity, previously received, and what came in
today:

| Case | Ordered | Received now | What happens |
|---|---|---|---|
| **Partial** | 10,000 m | 5,000 m | 5,000 to stock, pending drops to 5,000, line stays **open** for later receipts |
| **Short close** | 500 m | 400 m | Vendor cannot supply the last 100 m. Storekeeper ticks **Short Close**; pending goes to 0 and the line reads **completed** so it leaves the pending lists |
| **Full** | 1,500 m | 1,500 m | Pending 0, line **completed** automatically |
| **Skipped** | 2,000 m | 0 m | Left at 0 on this receipt; 2,000 stays pending for a future truck |
| **Excess** | 450 m | 500 m | Booked straight in. No limit, no question asked |

#### Excess and short receipts — no limit at all

**Decided: a receipt may book in any quantity, over or short, and it saves
without being questioned.** Fabric arrives in the lengths the supplier
sends it in, and a lorry at the gate is not the place to argue about it.

A percentage allowance was built and then removed. It had two settings —
2% by default, configurable — and past it the storekeeper was refused
until a reason was typed. In practice that only teaches whoever is
receiving to type a number the scale did not show, which is worse than the
over-delivery it was guarding against. There is now no tolerance
percentage, no refusal, and no setting.

What remains: a note box appears on its own once the quantities typed
exceed what the order still has outstanding, as somewhere to record why if
there is a reason worth keeping. It is never required.

The order's own quantity is still what the **bill** is matched against, so
nothing gets paid for twice.

#### Damaged goods (QC rejection)

Receive 1,000 m and inspection finds 200 m stained:

- **Accepted (800 m)** → usable stock.
- **Rejected (200 m)** → recorded against the receipt line, and **stays
  physically in the same warehouse**. **Decided: there is no separate
  Damage / Rejection store.** The mill does not move rejected fabric to a
  different godown, so neither does the system.
- **Only the accepted 800 m counts toward the order.** Pending becomes
  10,000 − 800 = 9,200 m.
- **Rejected goods are settled with money, not a stock movement.** The
  commercial resolution happens at billing — a debit note or credit note
  as the case requires. The rejection itself moves nothing.

Already built and unchanged by this.

#### From receipt to bill

When the supplier finally sends the bill, accounts raise a Purchase Bill
**against the GRNs, not the original order**:

```
Truck 1 (Challan 101) → GRN-001 (Item A: 5,000) ┐
Truck 2 (Challan 105) → GRN-002 (Item B: 400)   ├→ One bill (Invoice #777)
Truck 3 (Challan 112) → GRN-003 (Item E: 500)   ┘
```

- **Many receipts, one bill.** Supplier sends one invoice at month end;
  the accountant picks the supplier and ticks the unbilled GRNs. The system
  aggregates accepted quantities across all of them. **Built.**
- **One receipt, one bill.** An invoice arrives with a specific delivery;
  the accountant bills that single GRN. **Built.**
- **Price mismatch — rate variance.** PO rate ₹100/m, vendor invoices
  ₹105/m. **Built.** See below.

#### Rate variance

Quantity had been matched against the receipt since bills existed, so a
supplier could not bill for goods that never arrived. But they could bill
the goods that *did* arrive at any price they liked, and it would post.
That was the largest hole in Purchase, and it is now closed.

Deliberately kept simple — no ledger accounting, no approval queue, two
choices at the moment of entry:

**Detection.** Every bill line already points at the receipt line it
settles, and that receipt line carries the rate the order agreed. So the
comparison needs no new plumbing. When the accountant types the supplier's
rate, any difference beyond a rounding paise is flagged inline on the row:

```
Item A · 5,000 m
Order rate ₹100.00 · Billed ₹105.00 · +₹5.00/m · +₹25,000.00
```

**The bill cannot save while a flagged line is undecided.** Each one takes
one of two actions:

1. **Accept the supplier's rate.** The bill books at ₹105. A one-line
   reason is required — a rate rise agreed on the phone is a real thing,
   but it should be written down. The variance amount is stored on the
   line so it is reportable later.
2. **Book at the order rate.** The bill books at the agreed ₹100, and the
   system **drafts a debit note** to the supplier for the difference
   (₹5 × 5,000 + GST). It is left in **draft** — nobody should send a
   document to a supplier that a machine decided on alone.

**Both directions are flagged, but only over-charging offers a debit
note.** A supplier billing *below* the agreed rate is usually a wrong line
rather than a gift, so it is shown and must be acknowledged — but there is
nothing to claim back.

**No Purchase Price Variance ledger account.** Accounts is not built in
this ERP and the CA holds the real books (see §8). The variance is stored
as a number on the bill line and is reportable; a PPV ledger can come
later, when Accounts does, without changing anything here.

**No approval threshold** — consistent with the over-delivery decision
above. The reason field is the control.

**No migration was needed.** The order's rate already travels on the
receipt line the bill settles, so the comparison had everything it needed.
The decision does not need storing either: a line booked at the order's
rate *is* the record of that choice, and the draft debit note beside it is
the record of the claim. A reason for accepting a higher rate goes onto the
bill's own notes, prefixed `Rate agreed:`.

**Verified against live data** on PO-0006 / GRN-2627-0010 (1,000 mtr of
Cotton Poplin 40s ordered at ₹10):

| Attempt | Result |
|---|---|
| Billed ₹12, no decision made | Refused — names the item and both rates |
| Billed ₹12, accepted, no reason | Refused — "say why the higher rate was agreed" |
| Billed 5,000 against 1,000 accepted | Still refused, as before — no regression |

#### What this buys the mill

1. Storekeepers enter physical quantities — challan, vehicle, rolls,
   metres — without waiting on or worrying about tax paperwork.
2. Production can use the fabric the moment the receipt is confirmed.
3. Accounts never pay for missing or rejected goods, because bills are
   built from accepted receipt quantities.

### Decisions already made (18 Sep 2026)

Four choices the business gave, already built to:

1. **Receive and inspect on one screen**, not two. The old system splits
   them — a storekeeper records the arrival, then it waits in "Pending GRN
   for QC" for someone else. At this mill the same person does both.
2. **Keep the gate entry and challan fields** — all 14.
3. **One bill can cover several receipts**, from day one.
4. **Roll barcodes, later.** Not started.

---

## 3. Goods movement — job work, inward/outward, returns

### Job work

Fabric constantly leaves the mill for outside processing — 209 job-work
receipts in 19 months, more than any document type except purchase orders
and goods receipts. Two distinct directions, per §2's GRN table:

- **Outbound** — our fabric sent to a job worker (cutting, stitching,
  embroidery, washing, dyeing, fusing) and received back, tied to a
  job-work order. Under GST this movement legally needs a **job-work
  challan**, or it counts as a taxable sale. No template for one exists
  anywhere yet.
- **Inbound** — a customer's own fabric, received in against a sales order,
  for the mill to work on. This is "customer-supplied fabric" — the old
  system has it switched on and in heavy use, and [stock rule
  6](04-business-rules.md#6-stock) already accounts for it: it's stock we
  hold but do not own, kept out of our valuation.

The old system's "workstations" for production are not in-house machines —
they are named outside units: **Ritesh Enterprises, Nargis Fashion,
Poornima Enterprises, Shakil Ahmed Ansari.** Production is coordinated
across job-work partners, not run inside one building.

### VHAGAR's own inward/outward mechanics

VHAGAR (§5) runs a more granular version of the same idea, and its field
design is worth reusing wherever this ERP builds its own inward/outward
screens:

- **Inward** — one record per delivery (who supplied it, who physically
  carried it — kept as two separate fields, since the person who sent
  something and the driver who brought it are often different people). A
  delivery can hold several distinct fabrics, each with its own quantity,
  width, purpose (Sampling stock / Production stock), remarks, and photo.
- Cloth then sits in a **pool** (sampling or production) until drawn on.
- **Outward** — fabric issued to a named party (e.g. a job worker like
  "Balram Tailors"), for a stated purpose, cut to a named **size chart**
  (their own standard, or a buyer's — "U.S. Polo" is a named example of a
  buyer with its own chart). An outward lot draws against **specific
  inward deliveries**, oldest first, with a running balance per delivery —
  not against one undifferentiated stock number.
- Document numbering: `VH-IN-2608-0049` — prefix, `IN`, year-month, sequence.

### Goods returns — a separate, already-live system

A goods-return process exists today for LD Silk Mills, outside this ERP,
running between two offices:

1. **Head Office records the return** — party, broker, quality lines,
   amounts. Gets the next `LD-####` id. Status: **Posted**.
2. **In transit** — lorry receipt number and transport company recorded;
   Head Office notes the date sent to Bhiwandi. Sits in Bhiwandi's
   **Pending** queue.
3. **Bhiwandi Office confirms arrival** — marks it received, and adds two
   figures only they know: the transport cost actually paid, and
   Bhiwandi's own handling charges. Status: **Received**.

Kept deliberately as two numbers, not one: **"Head Office records what it
expects to pay. Bhiwandi records what was actually paid... the difference
between expected and actual is a number you can report on."** Receiving is
guarded so a return can only be received once.

A reason is recorded per return (e.g. "Bad Quality"). 341 real returns
exist; master lists (parties, brokers, transports, fabric qualities)
overlap only partly with the main ERP's own masters by name — merging them
needs manual review, not an automatic match.

**Open question:** does LD Cotton Mills (not just LD Silk Mills) also
return goods this way, and should this become a module here? See §11.

---

## 4. Production

Never set up in the old system's own wizard, yet holding the richest real
data in the account: **167 routings, 165 bills of materials, 14 processes,
19 workstations.** Read as "where the real knowledge about your factory
lives."

**Named processes** (at least): Cutting, Cutting QC, Fusing, Stitching,
Line QC, Kaj Button, Washing, Embroidery, Finishing, Final QC, Packing.

**Example routing**, a formal shirt:

```
Cutting → Cutting QC → Fusing → Stitching → Line QC → Kaj Button
  → Finishing → Final QC → Packing
```

An embroidered style adds two steps to that. A washed style adds Washing.
No two styles necessarily take the same path — that's why 167 routings
exist for what is presumably a much smaller number of base styles.

**QC is not one checkpoint, it's several** — Cutting QC, Line QC, Final QC
are three separate named gates in the routing data alone (VHAGAR's own
design runs five, see §5). Collapsing them into a single "QC passed" flag
loses the ability to tell whether a defect happened at cutting or at final
inspection.

**Sizes** were free text in five disconnected places in the old system
("XL" vs "xl"), breaking totals. This ERP already has `Size` and
`SizeGroup` masters built for exactly this reason — production, when
built, should use them rather than reintroduce free text.

**Who did the work** — the old system stores department as free text with
no link to a workstation, so the amount payable to (say) Nargis Fashion for
a run of stitching can never be totalled. Framed in the teardown as a money
problem, not a reporting nicety.

---

## 5. VHAGAR — full process

VHAGAR is a self-contained garment production and traceability operation,
currently its own separate app (tested at `localhost:3100`), not wired into
this ERP. Whether or how it should be is an open question — see §11. What
follows is how it actually runs today.

### The flow, four stages, and the unit that changes partway through

```
Fabric inward (metres) → Outward/production (pieces, by size)
  → Five QC gates (pieces passed, by size) → Handover (signature on file)
```

**The core rule:** stage 1 counts metres. From the moment cloth goes out to
be cut, everything after it counts **pieces of a given size**, and never
goes back to metres.

1. **Fabric inward** — fabric name, quantity, given by, purpose, plus a
   cloth specification: width, GSM, composition, colour, and the mill's own
   lot number (the one field that's free text — "it comes off the mill's
   tag"). Refused: a future date. A past date is allowed but the form asks
   why it's late.
2. **A style is entered** — SKU, fabric, design no., shade, fit, sample
   size, description, photos; optionally a production plan and materials
   list. SKU and fabric can both come later, but must be unique once set.
3. **A sample is cut and made** — cloth drawn from the sampling pool,
   oldest delivery first. Then ticked in order: Stitching → Washing → QC,
   each with who/when. Only the last tick can be undone.
4. **The MD decides** — Accepted (with a start date), Changes required
   (loops back to a new revision, cut and ticked again from step 3),
   Rejected, or Discarded.
5. **Production starts**, once a sample is Accepted — metres, a size ratio
   (from the plan, or a default of **2-10-10-5-2-1-1-1** across the size
   range), and who it's given to. Drawn from the production pool.
6. **The run is made and checked** — Cutting → Stitching → Washing → QC →
   Completed.
7. **Goods are handed over** — to whom, quantity per size, and whether it's
   given for good or lent (to come back later via "Returned"). **A
   handover is never complete without proof** — a signature on screen or a
   photo of the signed slip.

### The five QC gates, in strict order, no override

1. **Sampling** — Cutting, Stitching
2. **Trims & button** — Buttons, Cuff button, Pocket button, Collar
   button, Extra on pocket
3. **Washing** — Stains, Holes, Marks, Ripping, Weaving
4. **Final QC** — Thread cutting, Stains checking, Fabric quality, Washed
   properly, Stitch cutting quality, Thank you card, Bulb pin
5. **Packing** — Ironing, Collar strap, Butterfly, Polybag, Card board,
   M pin/R pin, Cloth bag

Each item is marked OK, a failed quantity, or not applicable; the whole
gate needs a named signature. Stated rule: **"A gate cannot be opened
until the one before it is signed... No overrides, including for an
admin."**

### Rules enforced regardless of screen

- A lot cannot draw more metres than the fabric has in stock.
- Passed plus rejected must equal inspected.
- A handover cannot be completed without a signature or a photo of the
  signed slip.
- Nothing is ever deleted — records are voided with a reason and stay in
  the trail.
- **Nobody but an admin types a rupee figure, and no operator screen shows
  one.**

### State machine (a style's life)

```
New → In sampling → [Changes required loops back to a new revision]
  → Approved → In production → In checking → Ready to go → Completed
(Rejected / Discarded samples → Closed)
```

### Roles

| Role | Can do |
|---|---|
| Admin | Everything, including Settings, people, and voiding records |
| Ops | Deliveries, pool moves, styles, samples, runs, materials, handovers, QC |
| Production · QC | Tick stages on lots; QC records checks |
| Store | Handovers and signatures |
| Viewer (the MD) | Reads everything, changes nothing |

Document numbering: `VH-IN-…` (delivery), `VH-OUT-…` (sample/run/custom
order), `VH-HD-…` (handover). A separate **custom order** record type
exists for one-off jobs (e.g. a specific colour/length cut) that draw from
the production pool like a run but aren't tied to a standard style.

---

## 6. Sales — lead to order

**This section is the least settled.** Five documents describe what look
like three or four different systems, under different names, with no
document stating how they relate. Presented as found, not reconciled.

### Textile LMS — AI-assisted outbound calling

A lead-management system with two areas, AI Ops and Sales. A lead is added,
AI researches it, and (if AI calling is switched on) an AI phones the lead
during set hours, up to 3 attempts; a connected call lands in a human
Audit Queue for a qualify/discard decision unless auto-qualification is on.
With AI calling off, a person calls manually and logs the outcome. Both
paths converge at **Follow-Up → First Meeting → Requirement → Negotiation
(quotation) → Won/Lost.** Rule stated throughout: **"You never just
'change a status' — you record what actually happened, and that's what
moves things along."**

### Incoming NBD — walk-in leads

A simpler system, no AI. **NBD here means "New Business Development,"**
not a document type. Every new lead gets exactly one follow-up scheduled —
the form won't let you skip it. Five-stage pipeline: **New → Contacted →
Sample Given → Quotation Sent → Negotiating.** Each stage needs its outcome
logged before the next one opens. Three ways a lead ends: **Won** (only by
recording the actual order — fabric, quantity, rate; "no order on file, no
won"), **Lost** (with a reason), or **Dormant** (parked, not lost).
Sample tracking recorded here too — hand-over vs courier, with courier/LR
reference, and an automatic "call for feedback" follow-up the moment a
sample goes out.

### CRR and SCOT — the live, confirmed-current system

SCOT is confirmed live in production (checked against real data 11 Sep
2026) and shared between **LD** (LD Cotton/Silk Mills) and **LinkD**
(Linkd Prints). It does not manage leads itself — it reads from a separate
system called **CRR**, described as: "Customers, aliases, open and closed
enquiries, nurtures, every follow-up." An **enquiry** is a live buying
requirement; a **nurture** is a client being warmed up who isn't ready to
order yet.

SCOT's job is deciding which *existing* customers a sales coordinator
should call, and when, to keep repeat orders coming in:

1. Reads each client's ordering rhythm (median gap between orders, not
   average) → Weekly / Biweekly / Monthly / Every 2 months.
2. Grades them by size (Star Client ₹50L+ lifetime, Potential ₹20–50L,
   Needs Growth ₹5–20L, Small/One-off <₹5L) and by reorder health (On
   track / Due / Overdue / Dormant, judged as a multiple of *that client's
   own* rhythm).
3. Turns rhythm into actual call dates, gated by five rules — not a
   Sunday, at least 25 days since the last order, at least one full cycle
   since last contact, no open CRR enquiry or active nurture ("while CRR
   owns the conversation, SCOT stays out"), not paused/snoozed/removed.
4. Builds each day's call list, priority = size weight × urgency, frozen
   nightly.

A separate **win-back list** targets past buyers, silent 90+ days, who
never placed an order under 100m (to exclude sample-only buyers).

**Known live bugs worth knowing about, not fixing here:** orders placed
through this ERP or "LD Order Entry" since August don't reach SCOT at all
— it still reads only Tally and a spreadsheet frozen at 30 Jul 2026, so
active buyers can show up as Dormant. And the "no Sunday calls" rule
silently drops clients whose cycle always lands on a Sunday, rather than
moving the call to Monday — 18 of 31 weekly LD clients are affected.

### What this means for building Sales here

CRR looks, from its own description, like the real home of the enquiry
process — but nothing confirms whether CRR **is** Textile LMS or Incoming
NBD under a different name, a successor to one of them, or a fourth
system entirely. **This needs a direct answer from the business before
Sales is designed** — see §11.

Once a lead becomes an order, the old system's flow continues: **Sales
Order → Delivery Challan (or DC Returnable / Non-Returnable) → Sales
Invoice → Payment Receipt**, with Credit Notes and Debit Notes for returns
and adjustments. Only the Sales Order (list, no create form yet) and
Sales Invoice model exist here so far.

---

## 7. HR & people

### What the old system shows

Never configured past two of eight setup pages. **Exactly one leave type
exists — "Unpaid Leave" — and all 75 employee balances sit at zero.**
Wages are worked out in Excel and filed by the company's CA; payroll never
ran in the software at all.

### What a separate, live system ("Appraise") shows

Not attendance or payroll — a **conduct and performance record**. Every
employee accumulates dated "positive contributions" and "goofups"
(documented mistakes), which roll into a computed signal: **Strong /
Stable / Watch / Attention / No signal**, weighted by impact (Low=1,
Medium=2, High=3.5, Critical=6) and decayed over time (roughly half-weight
at 8 months). A single critical goofup forces Attention regardless of
anything else. Rules: **you cannot record against yourself, not even as
Super Admin**; you have 48 hours to fix your own entry, after which only
Management can; nothing is ever hard-deleted, only archived.

This system's structure still reveals real facts about how the mill is
organised:

- **Two distinct worker populations.** **Backend Team** — office staff,
  has a login, paid monthly or annual CTC. **Production Team** — shop
  floor, no login at all, identified by an `employee_code` because most
  have no email, and rated in bulk by their supervisor on their behalf.
  ("Production workers never sign in — their supervisor fills their sheet
  in for them.")
- **Departments named in real data:** Design, Fusing, Printing, Weaving.
- **Roles beyond department:** HOD (reviews office reports), SUPERVISOR
  (the only role that can rate production workers), HR_ADMIN, and MD
  (approves reports **and pay decisions**).
- **Pay is captured as CTC** (monthly or annual), Indian-standard term for
  cost-to-company — confirmed for office staff, but no field anywhere
  covers day-rate or piece-rate, which is how a cutting/stitching floor is
  commonly paid.
- An increment cycle exists — default annual, HR alerted a month before
  it's due, tracked from date of joining and last increment.

### The gap

**No attendance mechanism, no piece-rate or daily-wage structure, and no
salary-advance/loan tracking appear in any document surveyed.** This is a
real hole, not an oversight in research — it needs a direct conversation
with the business before HR & Payroll is designed. See §11.

---

## 8. Accounts & money

### The old system's own posture

Deliberately not treated as the real ledger: **"Absolute is not your book
of record; your CA's books are."** 683 ledgers exist under 35 groups, but
only 68 carry any balance. Opening balances stop at 31 Mar 2025 and were
never rolled forward. No capital account, no fixed-asset register, no
stock account of any kind exists. The trial balance is out by roughly
₹99 lakh.

**Opening position as of 31 Mar 2025**, the numbers any future opening
balance migration would start from:

- 31 customers owing ~₹1.74 crore total (largest: Nexon Omniverse,
  ₹55,31,234)
- 27 suppliers owed ~₹1.89 crore total (largest: LD Silk Mills,
  ₹1,75,76,855, plus a separate ₹1,20,00,000 loan account)
- Bank ₹1,48,238.55, cash ₹9,936.98

### Brokers

Eleven named live agents found (examples: Jankidas Vasudev Vaishnav,
N. Kewal Textiles Agency, Shree Shyam Textile Agency), plus "SELF" for
direct sales. A live commission expense ledger exists, alongside a
**TDS on Brokerage (Section 194H)** liability ledger — the mill deducts
TDS on broker commission. No broker master exists in this ERP yet.

### LD Silk Mills' gross-profit tool

A separate reporting system, unconnected to this ERP, that ingests LD Silk
Mills' monthly sales register (a CSV export from an existing system
called "SAB," ~43 columns) and computes gross profit per line by matching
each sale to an effective-dated fabric cost rate. Built to replace a
manual Excel pack the MD currently reads every month.

Basis figures (net of returns, per its acceptance spec): Sales
₹26,73,80,910 / Fabric cost ₹21,63,37,066 / Gross profit ₹5,10,43,844 /
GP% 19.09%, across 9,092 sales lines and 386 customers.

**Explicitly out of scope for that tool:** purchasing, and — an open
question in its own build plan — whether it should also cover LD Cotton
Mills and Linkd Prints, since its source register carries a company column
with more than one value in it. See §11.

**Maharashtra professional tax** applies to payroll — noted for whenever
Payroll is built, not acted on here.

---

## 9. Tax specifics beyond the fixed rules

[Business rules §2](04-business-rules.md#2-gst) already covers the CGST/
SGST/IGST split and place-of-supply logic — this is supporting evidence
and detail found during the process research, not new rules.

- The old system's own real interstate spread — useful for sanity-checking
  any tax report: **Gujarat 30, Uttar Pradesh 12, Karnataka 12, Haryana 9**
  parties, out of 380 total.
- **A job-work fabric movement without a job-work challan counts as a
  taxable sale under GST**, not a stock transfer. No template for that
  challan exists yet, old system or new.
- **TDS under Section 194H applies to broker commission** — see §8.
- The old system's evidence for the "unregistered = no tax split, not an
  error" rule: one live supplier record has the literal string **"URP"**
  typed into its GST field, because no proper field existed for
  "unregistered person."

---

## 10. Master data — why the new rules exist

The old system's data quality is the direct justification for [rule 12,
master codes](04-business-rules.md#12-master-codes) and the "no data
migrates" decision already made (see PROJECT_STATUS.md):

- Of 380 parties (283 suppliers, 86 customers, 11 brokers), **only 5 had a
  party code filled in at all — "1", "2", "3", "55555", "KK2356."**
- 79 parties have no GSTIN. Recorded GSTINs include ones with trailing
  full stops, wrong lengths (12/14/16 characters instead of 15), one in
  lowercase, one holding a phone number, one holding the words "Indian
  Institut."
- One customer, Cubatics Garment, exists as three separate records under
  one GSTIN.
- **90 of 94 user accounts in the old system have unrestricted Admin
  access** — including shop-floor accounts on personal Gmail addresses,
  able to see every purchase price, customer rate, and payroll figure, and
  delete any of it. Only 3 roles were ever created in 5 years.

None of this data migrates. It's kept here only as the reason the new
system auto-generates codes and enforces real roles from the start.

---

## 11. Open questions — need a direct answer from the business

Everything below is a genuine gap in what's been surveyed, not something to
guess at:

1. **VHAGAR's fabric** — does it come from LD Silk Mills, or is it
   independent stock? No document says.
2. **Linkd Prints** — is it a company with its own GSTIN like LD Silk
   Mills, or part of the LD group some other way?
3. **Which sales/lead system is actually current** — Textile LMS,
   Incoming NBD, or is CRR the real one, with SCOT confirmed live
   downstream of it? All three/four were found; none of the documents
   say how they relate.
4. **The LD Silk Mills GP tool's scope** — does it need to cover LD
   Cotton Mills and Linkd Prints too, or LD Silk Mills alone?
5. **Goods returns** — does LD Cotton Mills use the same Head
   Office/Bhiwandi process as LD Silk Mills? Should it become a module
   here?
6. **Shop-floor pay** — piece-rate, daily wage, or something else? And how
   is attendance actually captured? Nothing surveyed says.
7. **GST rates beyond garments at 5%** — still needs the CA's written
   confirmation (already flagged in PROJECT_STATUS.md).
8. **Receive vs inspect, one screen or two, for Job Work GRN and GRN JW
   Customer** — decided one way for Purchase GRN (§2); worth asking
   again when those two get built, since a job worker returning goods may
   not suit the same answer.

---

## Sources

- `docs/04-business-rules.md`, `PROJECT_STATUS.md` — this repository
- Absolute ERP Teardown (24 Aug 2026) — full settings/setup read-through
- After the Purchase Order (18 Sep 2026) — live GRN/QC/Bill chain, traced
- Vhagar Production Flow (12 Aug 2026), Vhagar Workflow and Tests
  (18 Sep 2026), Vhagar Goes Native (19 Aug 2026)
- Employee Tracking Handbook, Staff Import Sheet (9 Sep 2026 / undated)
- Four Ways to Record Inward, Compact Outward Form, Goods Return LR,
  Incoming NBD (24 Aug – 5 Sep 2026)
- Textile LMS Lead Journey, One Lead Start to Finish, Stage-Routed Lead
  Workspace, How SCOT Decides (11 Sep – 17 Sep 2026)
- LD Silk GP Build Plan (10 Sep 2026)

All are published Artifacts on this account. Ask if you need the direct
links again.
