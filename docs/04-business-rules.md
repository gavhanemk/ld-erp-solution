# Business rules

The rules the software must never break. Some are law, some are accounting, some
are how a mill works. Breaking any of them costs real money or a real
explanation to a real officer.

If a rule here conflicts with something you are asked to build, the rule wins.
Come and discuss it.

---

## 1. Document numbers

Every document — order, invoice, challan, receipt — carries a number. The number
is the document's identity for the rest of its life.

**The rules:**

1. **A number is never repeated.** Two invoices with the same number is a GST
   offence.
2. **A number is never reused.** Cancel an invoice and its number stays cancelled.
   Do not hand it to the next one.
3. **Numbers run in sequence with no gaps.** A gap invites the question "what was
   in that one?".
4. **The number is decided by the software, never typed by a user.**
5. **A document belongs to the financial year on the document**, not the year
   today. A back-dated order joins last year's series.
6. **Maximum 16 characters.** Letters, digits, hyphen and slash only. No full
   stop, no underscore, no space. This is Rule 46(b) of the CGST Rules and it is
   not negotiable.

**How it is done:** `nextDocumentNumber(tx, docType, documentDate)` in
[docNumber.ts](../apps/api/src/lib/docNumber.ts), called **inside the same
database transaction that saves the document**. The counter increments
atomically, so two clerks pressing Save at the same moment cannot get the same
number. If the save fails, the number is rolled back with it.

Never build a number by joining strings. Never use a random number — this code
did once, and it could both collide and ignore the series the user had
configured.

**Document types in use:**

| Code | Document |
|---|---|
| `SO` | Sales order |
| `PO` | Purchase order |
| `MO` | Manufacturing order |
| `GRN` | Goods receipt |
| `INV` | Sales invoice |
| `MR` | Material requisition |
| `DC` | Delivery challan |
| `JW` | Job work challan |
| `CN` | Credit note |
| `DN` | Debit note |
| `VCH` | Voucher |

The financial year runs **April to March**. The 2026-27 year is written `2627`.

---

## 2. GST

This is where mistakes get expensive.

### The split

Every taxable document is either inside the state or across it. There is no
third case, and getting it wrong means the customer cannot claim the credit.

| Situation | Tax |
|---|---|
| Our state = place of supply | **CGST + SGST**, half each |
| Our state ≠ place of supply | **IGST**, the whole rate |

**The split is decided by the two-digit state code. Never by the state name.**

Maharashtra is `27`. The code is the first two digits of the GSTIN, so it is
always available.

This rule exists because the code once compared a state *name* against a state
*code* — "Maharashtra" against "GJ" — which never matched, so every sale in the
system was billed as IGST including local ones. Every one of them would have been
wrong.

Use `resolvePlaceOfSupply()` for sales and `purchaseTaxContext()` for purchases.
Do not write the comparison yourself.

### Place of supply

For goods, tax follows **where the goods are delivered**, not where the bill is
sent. So the shipping state wins over the billing state. If there is no shipping
state, fall back to billing, then to the GSTIN.

If none of them are known, **refuse to save**. A guessed tax split is worse than
a blocked screen.

### Unregistered parties

A supplier with no GSTIN is unregistered. There is no split to make and **no tax
on the document at all**. This is normal, not an error. The printed document says
so plainly.

### Rates

Garments are **5%**. Do not hard-code it anywhere — it is a `TaxRate` record and
it will change. Read it.

### Invoice copies

A tax invoice for goods is printed in three parts, and each part says which it
is: **Original for Recipient**, **Duplicate for Transporter**, **Triplicate for
Supplier**. That is Rule 48(1). The copy labels live in the document template so
they can be changed without a code change.

---

## 3. Master data is never deleted

Customers, suppliers, items, warehouses — these are pointed at by documents
forever. Delete one and a two-year-old invoice loses its supplier.

**So: deactivate, never delete.** `isActive = false`. The record stays, history
stays intact, and it disappears from the dropdowns.

`crudRouter` does this by default. A model can only opt out if nothing will ever
reference it.

The same applies to any document that has been sent to anyone. A confirmed
purchase order is not deleted; it is cancelled, and it stays visible.

---

## 4. What a document remembers

A document is a photograph of a moment. It must not change when the world does.

When you save a line, **copy onto it** anything that must not drift:

- The HSN code from the item
- The rate agreed at the time
- The tax rate applied
- The description as it read then

Correct the item master next week and last week's order must print exactly as it
did. If a document re-reads the master every time it is opened, it is wrong.

The only things that stay as live links are identity — which item, which
supplier — never values.

---

## 5. Draft and confirmed

Every document has two lives.

**Draft** — being typed. Editable, deletable, nothing has happened.

**Confirmed** (sent, approved, posted — the word differs by document) — it has
left the building. Someone else has seen it. From here:

- It cannot be edited.
- It cannot be deleted.
- It can be **cancelled**, which leaves the record and its number in place.
- It can be **amended**, which creates a new document that refers back to it.

A confirmed purchase order already refuses edits. Every future module does the
same.

---

## 6. Stock

Built. All of it is enforced in one file:
[`apps/api/src/services/stock.service.ts`](../apps/api/src/services/stock.service.ts).

1. **Stock is never negative.** If 100 metres are on hand, 120 cannot be issued.
   Refuse it and say what is available.
2. **Stock only moves through a document.** A GRN brings it in, an issue takes
   it out, a transfer moves it. Never a direct edit to a quantity — that is how
   stock becomes fiction.
3. **Every movement is a row.** The balance is the sum of the rows, not a number
   somebody keeps updating. If the balance is ever questioned, the rows are the
   answer.
4. **Stock lives in a warehouse.** "In stock" without a warehouse means nothing.
5. **Job work stock is still ours.** Fabric at a job worker is our stock at their
   location. It is not sold and it is not gone. `StockOwnership` exists for this.
   The reverse also holds: a customer's fabric in our godown is **not** ours, and
   is left out of the stock value.
6. **Value it consistently.** Weighted average, chosen once, for everything.

### How it is held

**One writer.** Nothing outside `stock.service.ts` may create a row in
`stock_ledger`. If you find yourself wanting to, you want a document instead.

**Every out-movement is locked.** Two people issuing 60 against 100 on hand
would both read "100 available" and both pass the check. A Postgres advisory
lock on the item and warehouse makes the second one wait, so the balance cannot
land at −20.

**Value is derived, never stored.** Quantity is what came in minus what went
out; value is the same sum priced at each row's own rate. Stock leaves at the
running average, which is what keeps the two in step — an item at zero quantity
is also at zero value.

**Three people, not one.** A requisition is raised by one person, approved by a
second and issued by a third. The person who raised it cannot approve it, and
both doors — the inventory screen and the approvals inbox — enforce that.

### What still has to come

Goods receipt is the missing inward document. Until it exists, stock arrives
only through opening balances and counts, and a purchase order does not yet
increase stock when the goods turn up.

---

## 7. Approvals

Some documents need a second person. Who and above what value is a setting, not
code.

- The person who raised it cannot approve it.
- An approval is recorded with who and when.
- A rejection carries a reason.
- Nothing moves on until it is approved.

---

## 8. Money

- Round to **2 decimal places** at every step, not only at the end.
- Round the final bill to the **whole rupee** and store the adjustment as
  round-off. A printed bill must add up when a clerk checks it with a calculator.
- Discount comes off before tax.
- The amount in words is generated, never typed. Indian grouping — lakh and
  crore, not million.
- Money is `Decimal` in the database. Never `Float`. Floats lose paise, and
  a few thousand invoices of lost paise is a real difference.

---

## 9. Who did what

Every create, edit and delete is recorded — who, when, from which address, and
the full record before and after.

This is not optional and it is not for debugging. When a rate on an order is
questioned six months later, the audit trail is the answer.

**Never write a secret into it.** The AI key is deliberately kept away from the
settings system so it can never reach an audit row.

---

## 10. One company per database

LD Cotton Mills and LD Silk Mills are two companies with **two different
GSTINs**. They are not two branches. Silk supplies fabric to Cotton, and that is
a purchase between two GST-registered businesses with a real tax invoice.

**So: LD Silk Mills is a supplier in this system. It is never a second company
inside one database.**

When a second company needs its own books, it gets its own Postgres schema —
which is why everything here lives in `ld_erp` and not `public`.

This also means the software must never assume the company. No "LD Cotton Mills"
in the code, no LD-specific rule that another mill could not switch off. It is
going to be sold to other companies.

---

## 11. Things that are settings, never code

If any of these appear as a literal in a file, it is a bug:

- Company name, address, GSTIN, PAN, bank details
- Tax rates
- Document number prefixes and formats
- The financial year
- Warehouse names
- State codes
- Approval limits
- Terms and conditions, declarations, footers on printed documents
- Rows per page, date format
- Which AI company answers, and which model

---

## 12. The assistant

The AI in this ERP is not trained on LD's data, and nobody should say it is.
It is given a short list of things it may **look up**, and it looks them up in
the live database each time it is asked. That distinction decides everything
about how it behaves.

Two sets of tools, and they follow different rules.
[`ai/tools.ts`](../apps/api/src/services/ai/tools.ts) answers questions.
[`ai/writeTools.ts`](../apps/api/src/services/ai/writeTools.ts) changes records.

**Reading:**

1. **It never sees more than the person asking.** Each tool names the permission
   it needs, and a tool that mixes subjects narrows its own answer field by
   field. A store keeper asking what customers owe is refused, in the same words
   the Accounts screen would use.
2. **There is no tool for a module that is not built.** A tool over an empty
   table would teach it to say "nothing to report" about a feature nobody has
   written.

**Changing:**

3. **Two permissions, not one.** The module permission the same act would need
   on a screen — `masters:create` to add a supplier — *and* a chat switch:
   `ai:create` to change records, `ai:approve` to decide documents. So a role
   can be allowed to add suppliers at a desk and not from a corridor. Both are
   ticked per role in Settings → Roles. **No role has `ai:create` out of the
   box.** Somebody has to decide to give it.
4. **Nothing happens on the first ask.** Every change is described in full,
   saved nowhere, and waits. It writes only when the person says yes and the
   signed ticket comes back. The ticket is bound to the exact values, to the
   person, and to the message it was issued on — so the assistant cannot propose
   and confirm in the same breath, and the values cannot drift between what
   somebody read and what gets written.
5. **The same rules as the screens.** The same Zod schemas the web forms post
   through, the same document numbering, the same refusals. There is no second,
   laxer way into the database.
6. **The audit row names the person who confirmed it**, never the assistant, and
   records that it came through the chat.
7. **Nothing that moves money or stock.** No invoices, no payments, no goods
   receipts, no stock issues. Those carry a document number, a tax position and
   a legal life, and they are worth the two minutes it takes to fill the form
   in. Raising a requisition and approving a document are allowed, because
   approving from a corridor is the whole reason an MD wanted this.

To make it better at something, add a tool or add to the background in
[`ai/prompt.ts`](../apps/api/src/services/ai/prompt.ts). Do not paste data into
the prompt: it goes stale the moment somebody edits a record, and stale is worse
than absent.

Which company answers — OpenAI or Google — is a setting in
Settings → Assistant, not a decision in the code.
