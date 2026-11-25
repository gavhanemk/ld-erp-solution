# Purchase Order Screen Rework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lay the purchase order form out as clear sections:

- a full-width item table with one item search box;
- a separate charges table, whose tax is changed only through an explicit window;
- a read-only summary;
- one bar of buttons.

The bill form shares the same charges table and summary.

**Architecture:** Rework `PurchaseOrderDialog.tsx` in place, keeping all its state and logic. Pull the charges and totals out into two new presentational components, plus one tax-change window, all used by both the order and bill forms. Pure display rules (where a rate comes from, whether a tax change is valid) go in a small `.ts` module, tested by a `tools/check-*.ts` script in the repo's usual style. The only API change is a delivery-date check.

**Tech Stack:** Next.js 15 / React (apps/web), Express + zod + Prisma (apps/api), `@ld-erp/shared` (priceDocument), tsx check scripts, Playwright e2e (e2e/browser).

**Spec:** `docs/superpowers/specs/2026-11-25-purchase-order-screen-design.md`

## Global Constraints

- **Calculation and server.** No change to `priceDocument()`, `priceSaleCharge()`, `resolveChargeConfigurations()` or any master or tax data. Sales screens (`SaleCharges`, `SalesInvoiceDialog`) and `ChargeTaxDetails.tsx` stay untouched.
- **Theme.**
  - No `dark:` Tailwind variants, because `<html>` always has class `dark`. Use theme tokens (`text-foreground`, `text-muted-foreground`, `bg-secondary`, `border-border`, `text-primary`, `warn-text`).
  - No change to global input styling.
- **Inputs.** Every number box is a `StepInput`.
- **Saving.** Save buttons stay enabled while the order is incomplete. Pressing one shows what is missing inline and scrolls to it. Buttons are disabled only while saving.
- **Labels and copy.**
  - Plain English, written from the user's side.
  - Button labels exactly: `Cancel`, `Save as draft`, `Save and print`, `Confirm order`; on a sent order `Save changes`.
  - GST source texts exactly:
    - `follows the goods`
    - `Masters → Charges`
    - `HSN / SAC <code>`
    - `No GST`
    - `No GST — supplier not registered`
    - `Changed: <reason>`
- **Keyboard.** Keep every `data-grid*` attribute, `data-hotkey="save"` (Ctrl+S), Alt+A / Alt+C / Alt+Delete, and Enter-down-a-column.
- **Test data.** Tests and walks use LD Cotton Mills data only, never VHAGAR. Run them on the demo database (`lderp_demo`, port 5433) only. Never run `prisma migrate dev`, `db push` or reset against any database.
- **Git.** Commit locally on `feat/purchase-redesign`. Don't push. Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A saved order whose charge tax was changed earlier, reopened.** The row reads `Changed: <reason>` with no "back to master" button. Saving again keeps the same tax.
2. **Supplier not registered (split `NONE`).** Every charge reads `No GST — supplier not registered`, not the master's rate.
3. **No supplier picked yet (split `null`).** The summary shows one GST row and "Pick the supplier…". Charges still show their tax.
4. **A % charge with no goods yet.** It shows "Add the goods first — the % is worked out on their value." and does not show 0% as a rate.
5. **A bill with the same charge type twice.** The rows stay independent: each has its own amount, tax change and remove.

Items 1–3 are pinned in Task 1's check script. Items 4–5 are pinned in Task 10's browser checks.

---

### Task 1: Charge display rules (pure)

**Files:**
- Create: `apps/web/src/components/purchase/chargeRules.ts`
- Test: `tools/check-purchase-charge-rules.ts`

**Interfaces:**
- Produces:
  - `chargeGstLabel(config: ChargeTaxSnapshot, priced: Pick<PricedCharge,'gstRate'|'parts'|'tax'> | undefined, split: GstSplit | null): { rate: string; source: string; changed: boolean }`
  - `type ChargeTaxDraft = { mode: 'INHERIT'|'HSN'|'MANUAL'|'NONE'; hsnCodeId: string|null; ownRate: number; treatment: 'INCLUSIVE'|'EXCLUSIVE'; taxCategory: ChargeTaxCategory; reason: string }`
  - `draftFromConfig(config: ChargeTaxSnapshot): ChargeTaxDraft`
  - `configFromDraft(base: ChargeTaxSnapshot, d: ChargeTaxDraft, hsn: HsnOption[]): ChargeTaxSnapshot`
  - `taxDraftProblem(d: ChargeTaxDraft): string | null`

- [ ] **Step 1: Write the failing check script**

  Use the `check(name, fn)` + `node:assert/strict` style of `tools/check-purchase-pricing.ts`, importing from `../apps/web/src/components/purchase/chargeRules`. Cases:

  - **Manual master rate.** `{followsGoodsRate:false, hsnCode:null, ownRate:5}`, priced `{gstRate:5, parts:[{gstRate:5…}], tax:60}`, split `'IGST'` → `{rate:'5%', source:'Masters → Charges', changed:false}`.
  - **Follows the goods.** `followsGoodsRate:true`, priced parts at 18 → `{rate:'18%', source:'follows the goods'}`.
  - **Mixed goods rates.** Parts at 5 and 18 → `rate:'5% / 18%'`.
  - **By HSN / SAC.** `hsnCode:'996511'`, ownRate 12 → `source:'HSN / SAC 996511'`.
  - **No GST.** `treatment:'NON_TAXABLE'` (or `gstApplicable:false`) → `{rate:'No GST', source:''}`.
  - **Changed.** `overrideReason:'GTA under RCM'` → `{source:'Changed: GTA under RCM', changed:true}`.
  - **Supplier not registered.** Split `'NONE'` with a manual 5% config → `{rate:'No GST', source:'No GST — supplier not registered'}`.
  - **No supplier yet.** Split `null` with a manual 5% config, priced tax 60 → `rate:'5%'`, still shown.
  - **Draft problems.** `taxDraftProblem`:
    - reason `'ab'` → `'Say why the tax is being changed (5 letters or more).'`
    - `taxCategory:'UNSPECIFIED'` → `'Choose a tax classification.'`
    - mode `'NONE'` with `'TAXABLE'` → `'A charge without GST is exempt, nil-rated or non-GST — not taxable.'`
    - mode `'HSN'` with no hsnCodeId → `'Pick an HSN / SAC code.'`
    - a valid draft → `null`.
  - **Draft to config.** `configFromDraft` with mode `'INHERIT'` → `followsGoodsRate:true, hsnCodeId:null, overrideReason` set. With mode `'HSN'` → `ownRate` equals the picked HSN's `gstRate` and `hsnCode` is its code. With mode `'NONE'` → `treatment:'NON_TAXABLE', ownRate:0`.

  These messages mirror the server's rules in `apps/api/src/services/chargeConfiguration.ts`.

- [ ] **Step 2: Run it and see it fail**

  Run from the worktree root: `npx tsx tools/check-purchase-charge-rules.ts`

  Expected: it fails with module not found for `chargeRules`.

- [ ] **Step 3: Implement the five exports in `chargeRules.ts`**

  - The rate text comes from `priced.parts` (unique rates, ascending, joined with `' / '`). Fall back to `config.ownRate` when there are no parts and tax > 0 is impossible.
  - Split `'NONE'` wins over everything, then no-GST, then changed, then follows / HSN / master.
  - Import `HsnOption` as a type from `./TaxBreakdown`.

- [ ] **Step 4: Run it and see it pass**

  Run: `npx tsx tools/check-purchase-charge-rules.ts`

  Expected: every line is `ok …`, with no assertion error.

- [ ] **Step 5: Commit**

  Message: `Purchase charges: rules for showing where a charge's GST comes from`.

### Task 2: Tax-change window

**Files:**
- Create: `apps/web/src/components/purchase/ChargeTaxDialog.tsx`

**Interfaces:**
- Consumes: Task 1's `ChargeTaxDraft`, `draftFromConfig`, `configFromDraft`, `taxDraftProblem`.
- Produces:
  ```ts
  ChargeTaxDialog({
    open, name, config, hsnOptions, canReset,
    preview: (c: ChargeTaxSnapshot) => { rate: string; tax: number },
    onApply: (c: ChargeTaxSnapshot) => void,
    onReset: () => void,
    onClose: () => void,
  })
  ```

- [ ] **Step 1: Build the window**

  - It is a centred modal: `fixed inset-0 z-[60]`, the same pattern as the PO address picker, `role="dialog"`, `aria-labelledby`.
  - Fields, in order:
    - GST from (4 radio buttons): `Follow the goods` / `HSN / SAC code` / `A rate I set` / `No GST`;
    - the HSN SmartSelect, when HSN is picked;
    - a `StepInput` for the % (decimals, max 100), when "A rate I set" is picked;
    - Amount is (`Before GST` / `GST included`), shown unless No GST;
    - Classification (Taxable / Exempt / Nil-rated / Non-GST);
    - Reason.
  - A live line shows "New tax: 18% · ₹216.00" from `preview(configFromDraft(...))`.
  - A problem from `taxDraftProblem` shows inline under the fields once Apply has been pressed.
  - Buttons: `Cancel`, `Back to the master's setting` (only when `canReset`), and `Apply`.
  - Escape closes. Nothing is applied until Apply.
  - The draft is re-created from `config` every time the window opens. It is never kept between openings, which is the bug fix.

- [ ] **Step 2: Type-check**

  Run: `pnpm --filter web type-check`

  Expected: exit 0.

- [ ] **Step 3: Commit**

  Message: `Purchase charges: a window to change a charge's tax, applied only on Apply`.

### Task 3: Shared charges table and summary

**Files:**
- Create: `apps/web/src/components/purchase/PurchaseChargesTable.tsx`
- Create: `apps/web/src/components/purchase/PurchaseSummary.tsx`

**Interfaces:**
- Consumes: Task 1's `chargeGstLabel`, Task 2's `ChargeTaxDialog`, and `TaxBreakdown` from `./TaxBreakdown`.
- Produces:
  ```ts
  export interface ChargeTableRow {
    key: string; name: string; unit: 'INR' | '%'; typed: string; enteredAmount: number
    config: ChargeTaxSnapshot; priced?: PricedCharge
    /** Changed in this form and not yet saved — "Back to the master's setting" is offered. */
    unsavedChange: boolean
  }
  PurchaseChargesTable({
    rows, split, goodsValue, canChangeTax, hsnOptions,
    addOptions: { id: string; name: string }[],
    onAmount(key: string, v: string), onUnit(key: string, u: 'INR' | '%'), onRemove(key: string),
    onAdd(typeId: string), onTaxChange(key: string, c: ChargeTaxSnapshot | null),
    preview(key: string, c: ChargeTaxSnapshot): { rate: string; tax: number },
    emptyHint?: ReactNode, footer?: ReactNode,
  })
  PurchaseSummary({
    result: PriceResult, split: GstSplit | null, totalLabel?: string,
    discountLabel?: string, extra?: ReactNode,
  })
  ```

- [ ] **Step 1: Build `PurchaseChargesTable`**

  - Columns: Charge · Amount · GST · Tax · Total · actions.
  - **Amount:** `StepInput` (decimals; max 100 when the unit is %) plus the ₹ / % pair, moved as-is from PurchaseOrderDialog.tsx:4438-4501, including the rule for switching units.
  - **GST:** shows `chargeGstLabel` as two lines, the rate on top and the source muted under it. "Changed" sources carry a small "Changed" chip.
  - **Tax and Total:** `priced.tax` and `priced.payable`.
  - **% hint:** for a % row, "x% of goods ₹y = ₹z" sits under the amount. With no goods it reads "Add the goods first — the % is worked out on their value."
  - **Actions:**
    - a pencil (`aria-label="Change tax on <name>"`), shown only when `canChangeTax`, which opens `ChargeTaxDialog` with `canReset = row.unsavedChange`;
    - an ✕ (`aria-label="Remove <name>"`).
  - **Below the rows:** `+ Add charge` as a SmartSelect over `addOptions`, hidden when there are none, then `emptyHint`, then `footer`.
  - **Narrow screens:** below `sm` each row stacks as a small card.

- [ ] **Step 2: Build `PurchaseSummary`**

  Read-only rows, in this order:

  - `Items` = `result.gross`
  - `discountLabel ?? 'Discount'` = `result.totalDiscount`, only when > 0
  - `Net items` = `result.goodsTaxable`
  - `Charges before GST` = `result.chargeTotal`, only when > 0
  - the tax rows:
    - split `CGST_SGST` → CGST, SGST;
    - `IGST` → IGST;
    - `NONE` → the text "No GST — this supplier is not registered.";
    - `null` → one `GST` row plus "Pick the supplier to see whether this is CGST + SGST or IGST."
  - `Total tax`
  - `<TaxBreakdown result split />`
  - `Other charges` = `result.untaxedExtra`, only when > 0
  - `Rounding`, only when |roundOff| ≥ 0.005
  - a highlighted `totalLabel ?? 'Grand total'` = `result.total`
  - `extra`

  Figures are `tabular-nums`, using the `en-IN` 2-decimal format already used in the forms.

- [ ] **Step 3: Type-check**

  Run: `pnpm --filter web type-check`

  Expected: exit 0.

- [ ] **Step 4: Commit**

  Message: `Purchase: shared charges table and summary`.

### Task 4: Order form — charges and summary wired in

**Files:**
- Modify: `apps/web/src/components/purchase/PurchaseOrderDialog.tsx` (Totals section at :4357-4593, totals memo at :1615-1700, discount at :4364-4382)

**Interfaces:**
- Consumes: Task 3's components.
- `chargeOverrides` (:710) already holds only this session's changes, so `unsavedChange = id in chargeOverrides`. `onTaxChange(key, null)` deletes the key, which falls back to the saved snapshot or the master via `configForCharge`.
- `preview` runs `priceDocument` with the same goods and that one charge's config, and returns its `gstRate` and `tax`.

- [ ] **Step 1: Replace the Totals section's charge cards with `PurchaseChargesTable`, and its rows with `PurchaseSummary`**

  - `canChangeTax = can('masters','edit')`.
  - `addOptions` are the purchase charge types not in `shownCharges`.
  - Keep the "No purchase charges are set up yet" hint (as `emptyHint`) and the retired-charges warning (as `footer`).
  - Remove the `ChargeTaxDetails` import from this file.

- [ ] **Step 2: Move the order-level discount `StepInput` (`id="po-discount"`) to the foot of the item table**

  Label it `Discount on the whole order (₹)`, shown only when `poType === 'ORDER_LEVEL'`. Replace today's plain `<input type="number">` with a `StepInput`.

- [ ] **Step 3: Type-check and run the pricing checks**

  Run: `pnpm --filter web type-check && npx tsx tools/check-purchase-pricing.ts`

  Expected: exit 0, and every pricing check `ok`.

- [ ] **Step 4: Commit**

  Message: `Purchase order: charges in their own table, tax changed only on Apply, plain summary`.

### Task 5: Order form — sections and header

**Files:**
- Modify: `apps/web/src/components/purchase/PurchaseOrderDialog.tsx`: header :2690-2732, Basic Details :2806-3105, Attachments & Deliver To / Terms / Notes / Template :3934-4346, outer grid around :3930 and :4594.

- [ ] **Step 1: Header**

  - Show the title plus a status chip, using the list page's badge map from `app/(dashboard)/purchase/orders/page.tsx:105-111`, shown when `isEdit`.
  - Subtitle when editing: `${poNumber} — can be changed until goods are received or billed`.
  - Remove `primarySave` from the header. Keep ✕.

- [ ] **Step 2: Order details**

  Order details is one compact grid.

  - **Row 1:** Supplier* · PO date · `Delivery by` (new `type="date"` input, `id="po-delivery"`, state `deliveryDate`, loaded from `record.deliveryDate`, sent as `deliveryDate: deliveryDate || null`). The supplier info strip goes under row 1.
  - **Row 2:** Location · PO no. (`#po-number`, label kept as "Purchase order*") · Order ref · a read-only `Indent / quote` text.
    - The indent part comes from unique `lines[].mrNumber`.
    - The quote part shows `enquiry.enquiryNumber` and `PI <piNumber>` when present.
  - **Row 3:** Remark.
  - Keep `#po-supplier`, `#po-location` and `#po-number` as they are, because the walk uses them.
  - An inline error `Delivery can't be before the order date.` shows under Delivery by when it is earlier than the PO date, and counts as missing (see Task 7).

- [ ] **Step 3: Layout**

  - Items stay full width.
  - Below them is a `lg:grid-cols-[minmax(0,1fr)_22rem]` grid:
    - left: Charges, then the collapsible sections;
    - right: Summary, `lg:sticky lg:top-0` inside the scrolling body.
  - Below `lg` the summary drops under.

- [ ] **Step 4: Collapsible sections**

  - Deliver to, Attachments, Terms & conditions and Notes each become a `<details>` with a one-line summary in the header:
    - Deliver to: the warehouse or customer name;
    - Attachments: `n attached` or `none`;
    - Terms & conditions: `n characters`;
    - Notes: `nothing written` or the first 60 characters.
  - Deliver to opens by default when the customer option is chosen.
  - The Template & Email section is removed. Its "Edit" link to the print-wording settings moves into Terms & conditions as `Edit the printed wording`.

- [ ] **Step 5: Type-check, then commit**

  Run: `pnpm --filter web type-check`

  Expected: exit 0.

  Commit message: `Purchase order: order details, items, charges and summary as clear sections`.

### Task 6: Order form — one item search box

**Files:**
- Modify: `apps/web/src/components/purchase/PurchaseOrderDialog.tsx`: item cell :3279-3404, `itemsFor` :1350-1376, `pickItemFor` :1894-1985, `chooseCategory` :1862, column widths `COL` :481-498, header :3170-3181.
- Modify: `e2e/browser/keyboard.mjs`. At :291, :340 and :367 the item box is `row.locator('button[role="combobox"]').nth(3)`; change it to `row.getByLabel(/^Row \d+ item$/)`.

- [ ] **Step 1: Replace the Category, Sub-category, Code and Name pickers with one SmartSelect**

  - It carries `aria-label="Row N item"`.
  - Each option's text is `CODE — Name`, and its `data-sub` is `Category › Sub-category · UOM`.
  - Options come from `itemsFor(row)` with the category filter dropped:
    - goods orders keep today's exclusion of Expenses items;
    - service orders offer every item, Expenses items first.
  - `+ Add a new item…` (`ADD_NEW`) stays and opens `NewItemDialog`. It passes the row's existing category / sub-category, which may be empty.
  - Picking an item calls `pickItemFor` exactly as today.
  - **Under the box:** muted text `Category › Sub-category · HSN x · unit`, plus the existing indent no. and sample ref.
  - The Category column is removed from the header and `COL`.

- [ ] **Step 2: Hide the Discount column unless `poType === 'ITEM_LEVEL'`**

  This covers the header cell, the body cell and the `COL` entry.

- [ ] **Step 3: Type-check, then commit**

  Run: `pnpm --filter web type-check`

  Expected: exit 0.

  Commit message: `Purchase order: one search box for the item; discount column only when used`.

### Task 7: Order form — the action bar

**Files:**
- Modify: `apps/web/src/components/purchase/PurchaseOrderDialog.tsx`: `primarySave` / `saveActions` :2624-2675, `save(mode)` :2472, footer :2597-2639, `incomplete` :2588.
- Modify: `e2e/browser/steps/11-po.js`. At :43, `getByRole('button', { name: 'Save', exact: true })` becomes `{ name: 'Confirm order', exact: true }`.

**Interfaces:**
- Produces: `revealMissing(): void`. It sets `showMissing = true`, scrolls the first missing target into view and focuses it. The targets, in order:
  - `#po-supplier`;
  - `#po-delivery` (when it is before the order date);
  - otherwise the first unfinished row's first empty box: `[aria-label="Row N item"]`, then `[aria-label="Row N quantity"]`, then `[aria-label="Row N rate"]`, then the row's sample-reason box.

- [ ] **Step 1: Make the buttons always enabled except while `busy`**

  `save(mode)` starts with `if (incomplete) { revealMissing(); return }`. The "Still to fill in…" message shows when `showMissing && incomplete`.

- [ ] **Step 2: Buttons, by state**

  - **A new or draft order:** `Cancel` · `Save as draft` (`data-hotkey="save"`, Ctrl+S, `save('draft')`) · `Save and print` (`save('print')`) · **`Confirm order`** (`btn-primary`, `save('send')`).
  - **A sent order** (`record?.status` not DRAFT): `Cancel` · `Save and print` · **`Save changes`** (`btn-primary`, `data-hotkey="save"`, `save('draft')`, which PATCHes and keeps the order Sent as today).

- [ ] **Step 3: Type-check, then commit**

  Run: `pnpm --filter web type-check`

  Expected: exit 0.

  Commit message: `Purchase order: one bar of buttons, always pressable, shows what is missing`.

### Task 8: Delivery date check and print

**Files:**
- Modify: `apps/api/src/routes/purchase.routes.ts`: POST `/orders` (:1250) and PATCH `/orders/:id` (:1506).
- Modify: the purchase-order print page under `apps/web/src/app/print/purchase-order/` (find it with `grep -rl "purchase-order" apps/web/src/app/print`).
- Test: `tools/check-po-delivery-date.ts` (API-level, demo only, in the style of `tools/check-buy-units-api.ts`).

- [ ] **Step 1: Write the failing check**

  It signs in via `E2E_EMAIL` / `E2E_PASSWORD`, refuses to run unless the API's database is `lderp_demo` (copy the guard from `tools/check-buy-units-api.ts`), and then checks:

  - create a draft PO with `poDate` 2026-11-25 and `deliveryDate` 2026-11-20 → expect 400 with code `DELIVERY_BEFORE_ORDER`;
  - `deliveryDate` 2026-12-05 → 201, and GET returns `deliveryDate` starting `2026-12-05`;
  - PATCH it to 2026-11-01 → 400 `DELIVERY_BEFORE_ORDER`;
  - delete the draft at the end.

- [ ] **Step 2: Run it against the demo API and see it fail**

  Run: `API_URL=http://localhost:5106/api npx tsx tools/check-po-delivery-date.ts`

  Expected: FAIL on the first case, because the API accepts it today.

- [ ] **Step 3: Add the server check**

  Add it in both routes after parsing: when both dates are set and `deliveryDate < startOfDay(poDate)`, throw `new AppError("Delivery can't be before the order date.", 400, 'DELIVERY_BEFORE_ORDER')`. On PATCH, compare against the stored `poDate` when none is sent.

- [ ] **Step 4: Print it**

  Add a `Delivery by` line to the print page's header details, shown only when the date is set and formatted `en-IN`.

- [ ] **Step 5: Run the check, see it pass, and type-check the API**

  Run: `pnpm --filter api type-check && API_URL=http://localhost:5106/api npx tsx tools/check-po-delivery-date.ts`

  Expected: all `ok`.

- [ ] **Step 6: Commit**

  Message: `Purchase order: delivery date on the form and print, never before the order date`.

### Task 9: Bill form — same charges table and summary

**Files:**
- Modify: `apps/web/src/components/purchase/PurchaseBillDialog.tsx`: charges :3225-3360, Totals :3405-3470, `configForCharge`, and the submit at :1960.

**Interfaces:**
- Consumes: Task 3's components.
- Row key = the index as a string, because bills may repeat a type.
- `unsavedChange = !!c.taxOverride` (the bill keeps the session's change on the row as `taxOverride`).
- `onTaxChange(key, null)` clears `taxOverride`.
- `onAdd(typeId)` appends `{ chargeTypeId: typeId, amount: '', gstMode, hsnCodeId, gstRate }`, with the same defaults as today's picker (:3245-3270).
- `addOptions` lists every active purchase charge type.

- [ ] **Step 1: Swap the charge rows for `PurchaseChargesTable`**

  - The "Charges from PO-… added" note and the explanatory line move into `footer`.
  - Remove the `ChargeTaxDetails` import.

- [ ] **Step 2: Swap the Totals rows for `PurchaseSummary`**

  - `totalLabel='Bill total'`.
  - `extra` carries the reverse-charge note, Less TDS, Net payable and the TDS note, unchanged.
  - The expense-mode `Subtotal` label becomes `discountLabel` / `Items` as appropriate. Keep the figures.

- [ ] **Step 3: Type-check, then commit**

  Run: `pnpm --filter web type-check`

  Expected: exit 0.

  Commit message: `Purchase bill: the same charges table and summary as the order`.

### Task 10: Verify end to end on the demo database

**Files:**
- Test: `e2e/browser/keyboard.mjs`, `e2e/browser/walk.mjs`, plus an ad-hoc Playwright script in the session scratchpad for the checks below.

- [ ] **Step 1: Builds**

  Run: `pnpm --filter api build && pnpm --filter web build`

  Expected: both exit 0.

- [ ] **Step 2: Start the demo stack**

  Use the demo DB on 5433 (start it with `node e2e/demo-db/start.mjs` from `LD ERP CGRN` if it is down), the API on 5106 and web on 3306 from this worktree, with the env exactly as in `e2e/README.md`.

  `migrate status` against the demo first. Apply only with `migrate deploy`, and only main's own migrations.

- [ ] **Step 3: Keyboard suite**

  Run: `cd e2e && npm run test:keys`

  Expected: the purchase-order checks pass ("two item lines … saved as a draft", "Enter goes … one line down", "Alt+C copies a PO line").

- [ ] **Step 4: Browser checks (ad-hoc Playwright script, screenshots to the scratchpad)**

  - **Direct PO.**
    - One LD Cotton Mills packing item at 18%, plus Transport Charges ₹1,200.
    - The row shows `5%` / `Masters → Charges`, and the summary IGST or CGST+SGST adds up.
    - Change tax → Follow the goods, with a reason and Taxable → the row shows `18%` / `Changed: …`.
    - Confirm order → the print page's grand total equals the form's.
  - **% charge with no goods** → the "Add the goods first" hint.
  - **Unregistered supplier** → every charge reads `No GST — supplier not registered`.
  - **Reopen the saved order** → `Changed: …` and no "Back to the master's setting".
  - **Signed in as a user without `masters:edit`** → no pencil.
  - **Press Confirm order with a row missing its rate** → the message shows and focus lands on `Row 1 rate`.
  - **Bill from that PO's receipt** → the charges arrive with the same tax.
  - **The same charge added twice on a bill** → the rows stay independent.

- [ ] **Step 5: Full walk**

  Run: `cd e2e && npm run test:walk`

  Expected: it reaches the end. The PO step (11) passes with `Confirm order`.

- [ ] **Step 6: Look at the screenshots**

  Check them at 1366×768 and 1920×1080 in both the light and dark themes, for overlap, clipping and unreadable text. Fix what's found, then commit: `Purchase order rework: fixes from the browser checks`.
