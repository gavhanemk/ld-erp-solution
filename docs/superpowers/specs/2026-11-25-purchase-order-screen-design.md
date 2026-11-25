# Purchase Order screen — rework (part 1 of 3)

25 Nov 2026 · branch `feat/purchase-redesign` (from main 8064c10f)

## Why

The user's review of the current Purchase Order form scored UI structure 4/10,
visual hierarchy 4/10, and additional-charge usability 3/10. Their complaints:

- too much blank space;
- crowded fields;
- charges squeezed into the narrow Totals panel, with tax settings anyone can
  open and get lost in;
- a GST figure that seems to contradict its own setting (goods at 18%, transport
  showing 5% while the dropdown says "Inherit from goods").

The guiding line: *"The purchase operator should spend time entering actual
purchase information, not configuring the ERP."*

This is part 1 of three, agreed in this order:

1. Order screen, charges table and GST display fix (this document)
2. Approval by role
3. Item details that change with the material

Landed cost is left out for now.

## Goals

- **Layout.** Lay the order form out as clear sections: order details → full-width
  item table → charges table → collapsible extras → summary → one sticky bar of
  buttons.
- **Charges.** The operator picks a charge and types its amount; nothing else is
  needed.
  - GST comes from Masters → Charges, exactly as today.
  - Each row says where its rate comes from.
  - Changing a charge's tax is a deliberate step, in a small window, offered only
    to users who are allowed to change it.
- **Summary.** A clear, read-only summary that adds up to what is saved and
  printed.
- **Items.** One searchable box picks an item, replacing the four dropdowns
  (category, sub-category, code, name).
- **Bill form.** It uses the same charges table and summary, so orders and bills
  show charges the same way.

## Non-goals

- Approval by role (part 2) and material-specific item details (part 3).
- Landed cost.
- Any change to master data or tax configuration. Transport Charges stays at
  whatever Masters → Charges says; the user decides that.
- Any change to how GST is calculated (the only API change is the delivery-date
  check). `priceDocument()` (packages/shared) and the
  server's `resolveChargeConfigurations()` are correct and stay as they are.
- The sales screens. They share `ChargeTaxDetails` and keep it unchanged.

## Anti-goals: a failure even if it "works"

- **Losing anything the form does today:**
  - indent lines ("Select from indent") and sample needs;
  - buying in packs (the unit picker), whole-number quantity guards and "Use last
    ₹x" rate history;
  - service orders (Expenses-only items), item-level vs order-level vs no discount,
    and the legacy "Other charges" move;
  - editing a sent order, short-closed lines, enquiry-raised orders (read-only PI
    strip), attachments, deliver-to-customer and the supplier address picker;
  - keyboard behaviour: `data-grid` rows, Enter down a column, Tab across, Alt+A /
    Alt+C / Alt+Delete, Ctrl+S = save as draft.
- **The screen showing a tax choice that is not actually applied.** This is the
  bug behind the screenshot.
- **Displayed, saved and printed totals disagreeing by even a paisa.**

## What was found (dependencies checked)

- **The GST "mismatch" is a display problem, not a calculation bug.**
  - `ChargeTaxDetails` keeps an unapplied draft in its "Advanced Tax Settings"
    panel. That draft only takes effect after a 5+ character reason, a
    classification other than UNSPECIFIED, and "Apply tax override".
  - The 5% shown is the applied configuration: Transport Charges' purchase default
    in the master, manual 5% (seed-core.ts:295, `defaultGstMode` MANUAL).
  - With "Follow the goods" actually applied, `shareSaleCharge` splits the charge
    across the goods' rates and gives 18% here.
- **The server is authoritative.**
  - It rebuilds each charge's configuration (saved snapshot → master → optional
    override) and re-prices it.
  - It refuses a `taxOverride` from anyone without `masters:edit`
    (`chargeConfiguration.ts`, `CHARGE_TAX_FORBIDDEN`).
  - No API change is needed.
- **`ChargeTaxDetails` is also used by `SaleCharges` and `SalesInvoiceDialog`.** The
  new purchase pieces are separate components, and `ChargeTaxDetails` is left
  untouched for sales.
- **The API still accepts `deliveryDate`.** The form stopped asking for it at some
  point; the user's spec asks for "Expected delivery date" again.
- **Save buttons are disabled today while the order is incomplete.** That breaks the
  standing rule: keep Save enabled, show what is missing inline and scroll to it.
- **A wrong line on the screen.** The subtitle "only a draft order can be changed"
  is untrue: the server allows edits while the order is Sent, until a receipt or
  bill exists.

## Approaches considered

1. **Rework the existing form in place — chosen by the user.**
   - Keep the logic of `PurchaseOrderDialog.tsx` (5,184 lines).
   - Rearrange its JSX into the new sections.
   - Pull charges and totals out into two shared components.
   - Replace the item pickers with one search box.
   - Lowest risk to the behaviours listed under anti-goals.
2. **A new order screen from scratch.** Cleaner code, but every behaviour above
   would have to be rebuilt and retested. Rejected: it goes against "preserve what
   works".
3. **Charges and GST only.** Leaves the crowded layout the review scored 4/10.
   Rejected.

## Design

### Screen layout (purchase order)

```
┌ Purchase Order · PO-0042 · Draft ······································ ✕ ┐
│ ORDER DETAILS                                                             │
│ Supplier* [Sahil Fabrics ▾]   PO date [25-11-2026]   Delivery by [      ]   │
│  GSTIN 27AB… · 98200 21003 · sup@… · Pay 45 days · Bill to Works  Change  │
│ Location [Bhiwandi ▾]  Order ref [      ]  Indent/Quote: MR-12 · ENQ-4     │
│ Remark [                                         ]                       │
├───────────────────────────────────────────────────────────────────────────┤
│ ITEMS                         Discount [None ▾]   [Select from indent]    │
│ #  Item                          Style  Description  Qty    Rate  GST  Amount│
│ 1  [PKG-BOX-001 Carton 5 Ply ▾]  [   ]  [        ]   1000   12.00 18% 12,000│
│    Packing Material · HSN 4819 · pcs · Use last ₹11.50                      │
│ + Add item row (Alt+A)                                                     │
├──────────────────────────────────────────┬────────────────────────────────┤
│ CHARGES                                  │ SUMMARY                        │
│ Charge      Amount       GST         Tax   Total │ Items            12,000.00 │
│ Transport   [1200][₹|%]  5% · master  60  1,260 ✎✕│ Discount             0.00 │
│ [+ Add charge ▾]                                 │ Net items        12,000.00 │
│                                          │ Charges before GST  1,200.00   │
│ ▸ Deliver to · LD Cotton Mills, Bhiwandi │ IGST             2,220.00      │
│ ▸ Attachments · none                     │ Total tax        2,220.00      │
│ ▸ Terms & conditions · 628 characters    │ ▸ Tax by rate                  │
│ ▸ Notes · nothing written                │ Rounding             0.00      │
│                                          │ Grand total    ₹15,420.00      │
├──────────────────────────────────────────┴────────────────────────────────┤
│ Still to fill in: Carton (rate)      Cancel  Save as draft  Save & print  [Confirm order] │
└───────────────────────────────────────────────────────────────────────────┘
```

**Order details**

- Same fields as today: location, PO no., date, supplier, reference, remark, the
  supplier info strip, and the enquiry strip when there is one.
- Adds an optional **Delivery by** date, sent as `deliveryDate`.
  - A date before the PO date is refused: an inline message on the form, and a
    400 from the API.
  - When set, it is printed on the order (purchase-order print page), so the
    supplier sees it.
- Indent and quotation references are shown read-only when the order carries them:
  the indent numbers come from the lines' `mrNumber`, and the enquiry / PI from the
  enquiry strip.
- Laid out as a compact grid with no empty columns.

**Items**

- Full width, spreadsheet style.
- The item cell is one searchable dropdown:
  - Each option reads "CODE — Name", with "Category › Sub-category · unit" as its
    second line (SmartSelect `data-sub`).
  - The search matches code, name or category.
  - "+ Add a new item…" stays.
- Category and sub-category are no longer pickers. They show as text under the item,
  with HSN, unit, indent no. and sample ref.
- The same narrowing rule as today (checked in the code):
  - goods orders hide Expenses items;
  - service orders offer every item, with Expenses items listed first, because their
    rows start on the Expenses category but are not restricted to it.
- The Discount column shows only when the order type is "discount at item level".
- The order-level discount box moves from the totals panel to the foot of the item
  table, because it is a discount on the goods.
- Everything else per row (pack unit picker, "Use last ₹", Exempt tick, Style no.,
  Description) is kept as is.

**Charges table** (new shared component, `PurchaseChargesTable`)

- One row per charge, with these columns:
  - Charge name.
  - Amount: StepInput plus the ₹ / % toggle, as today; "x% of goods ₹y = ₹z" under
    it when the amount is a %.
  - GST: rate plus where it comes from:
    - "18% · follows the goods"
    - "5% · Masters → Charges"
    - "12% · SAC 996511"
    - "No GST"
    - "Changed: <reason>" when overridden on this document.
  - Tax amount and total.
  - Actions: a "Change tax" pencil (only when `can('masters','edit')`) and Remove.
- **"+ Add charge"** offers the active purchase charges from the master:
  - On an order, only types not already on it, as today.
  - On a bill, any type, because a bill may repeat a type.
- **"Change tax"** opens a small window that holds the controls today's "Advanced Tax
  Settings" has:
  - Follow the goods / HSN-SAC / Manual % / No GST;
  - HSN picker;
  - GST-exclusive / inclusive;
  - classification;
  - reason;
  - a live preview of the new tax;
  - Apply / Cancel;
  - "Back to the master's setting" when the row is already overridden.

  Nothing on the row changes until Apply. The window validates exactly as the server
  does: reason of 5+ characters, a classification, and "No GST" never classed as
  Taxable. The payload is the existing `taxOverridePayload`.

  "Back to the master's setting" is offered only for a change made since the form
  was opened and not yet saved. Once saved, the server keeps a row's saved setting
  on every later save. That is deliberate and shared with sales, so it is not changed
  here. A saved change can still be changed again through this window. Offering a
  reset the server would ignore would bring back the exact bug being fixed.
- The quick "GST Applicable / No GST" dropdown on each charge goes. Turning GST off is
  done through "Change tax" (No GST), and only by permitted users, as now.
- A retired charge's warning and the empty-master hint ("No purchase charges are set
  up yet") are kept.

**Summary** (new shared component, `PurchaseSummary`)

- Read-only, every figure taken from the one `priceDocument()` result.
- Rows:
  - Items (gross)
  - Discount (only when there is one)
  - Net items
  - Charges before GST (only when there are charges)
  - CGST + SGST, or IGST, or "No GST — supplier not registered", or (no supplier
    yet) one GST row plus "Pick the supplier…"
  - Total tax
  - Tax by rate (the existing `TaxBreakdown`, collapsed)
  - Other charges (legacy, only when present)
  - Rounding (only when not zero)
  - Grand total
- On wide screens it sits beside the charges and stays in view (sticky) while the
  column scrolls.
- Extra rows can be passed in. The bill uses this for reverse charge, Less TDS and
  Net payable.

**Supporting information**

- Deliver to (warehouse or customer, and address), Attachments, Terms & conditions
  and Notes become collapsed sections. Each header carries a one-line summary.
- **Template & Email is hidden**, because emailing is not built. An "Edit the printed
  wording" link moves under Terms & conditions.

**Action bar**

- One sticky footer with these buttons:
  - Cancel
  - Save as draft (Ctrl+S, gives DRAFT)
  - Save and print (gives SENT, then opens the print page)
  - **Confirm order** (primary; save and send, giving SENT; renamed from "Save")
- The duplicate Save in the header goes.
- **Buttons stay enabled while the order is incomplete.** Pressing one shows what is
  missing (the existing "Still to fill in…" message) and scrolls to and focuses the
  first missing field. Nothing is sent to the server. Buttons are disabled only while
  saving, which also blocks a double submit.
- **On an order that is already Sent** (it can be edited until goods or a bill
  arrive), the bar reads Cancel · Save and print · **Save changes**, and Ctrl+S saves
  changes. The server has no way back to Draft, and today's form already keeps a sent
  order Sent, so "Save as draft" and "Confirm order" would be misleading there.
- **Header:** the title plus a status chip (Draft / Sent / Part received…). The
  subtitle is corrected to "can be changed until goods are received or billed".

### Bill form

- Its charges move onto `PurchaseChargesTable`. The per-row charge-type picker becomes
  the "+ Add charge" dropdown.
- Carried-from-order rows keep `sourceChargeId` and their saved snapshot.
- Its totals move onto `PurchaseSummary`, with TDS / net payable / reverse charge
  passed as extra rows.
- Nothing else on the bill changes: matching, rate variances, TDS panel and expense
  mode.

### Look

- Existing theme tokens and teal; no new colours.
- No `dark:` variants, because `<html>` always has class `dark`. Light theme is the
  `.light` class.
- Inputs 36–40px, cards 10–12px radius, consistent section padding.
- The global input background is **not** changed, because it would restyle every
  screen in the ERP.

## Calls made after the builder check (the user can overrule any)

- Reset-to-master only for unsaved changes (see Charges table).
- Service orders keep today's item rule: every item, Expenses first.
- A sent order gets "Save changes" in place of draft / confirm.
- Delivery-by is printed, and can't be before the PO date. This needs a small API
  check and a print-page line: the only API change in part 1.

## Left to the builder

- Exact component boundaries and prop shapes, file names, and how the "missing
  field" scroll finds its target.
- Breakpoints: below about 1100px wide, the summary drops under the charges.
- Whether the item search reuses SmartSelect as is or needs a small extension for
  matching category text.

## Testing

- Type-check and production build (api, web).
- `tools/check-purchase-pricing.ts` and the existing e2e purchase suites on the demo
  database, which must still pass.
- A browser walk on the demo database (LD Cotton Mills items only, no VHAGAR) for each
  of these:
  - a direct PO;
  - a PO from an indent;
  - packs;
  - a service order;
  - order-level discount;
  - a % charge;
  - Change tax to "Follow the goods" (18% shown and saved);
  - a user without `masters:edit` (no pencil);
  - save draft / confirm / print with the totals matching the print page;
  - editing a sent order;
  - a bill carrying the PO's charges;
  - the keyboard keys.
