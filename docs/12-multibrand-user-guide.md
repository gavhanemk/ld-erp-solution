# Multi-brand: how to use it

For the people who use LD ERP every day: sales, purchase, stores, production and accounts. Written 28 Nov 2026 for the multi-brand release.

LD Cotton Mills, Stich Code and VHAGAR are three brands of one company. There is one GSTIN, one set of books and one stock ledger. Four words come up often in this guide:

- **Central stock** belongs to the company and is kept for no brand. Any brand may use it.
- **A brand's share** is stock earmarked for that brand. It is the same cloth on the same rack. Only whose it is changes, never where it is.
- **A share's cost:** each share keeps its own average cost, so one brand's dearer purchase does not raise another brand's cost.
- **Not split:** in the accounts, an amount that belongs to no single brand, such as central stock or shared expenses.

## Who does what

| Person | Does |
| --- | --- |
| Sales | Picks the brand on quotations and orders. Changes a charge's GST on a document only with the right "Override Sales Charge GST". |
| Purchase | Picks the brand on a purchase order, or leaves it "Common — no brand" for central stock. |
| Store keeper | Raises earmarks, moves and releases, and names the rolls or scans the tags. |
| Store manager | Approves brand stock moves, never their own. |
| Production manager | Approves extra material for an MO, never their own request. |
| Accountant | Allocates shared expenses each month, reads the P&L by brand, closes the books. Reopens a closed period only with the right "Reopen closed periods". |
| Admin | May approve their own request only as an override, with a written reason. |

## 1. Picking the brand

**Quotations and sales orders.** Sales → Sales Orders → **New order** → Basic Details → **Brand**.
- The brand must be chosen. Until you pick one, it follows the styles on the order.
- One order carries one brand. If a line's style belongs to another brand, the order is refused: put those styles on their own order.
- Job work is always booked under LD Cotton Mills.
- Quotations work the same way.

**Manufacturing orders.** Production → Manufacturing Orders → **New MO** → **Made for**.
- *A sales order:* the MO takes the order's brand.
- *Direct (no sales order):* pick the **Brand** yourself.

**Purchase orders.** Purchase → Purchase Orders → **New Purchase Order** → Order details → **Brand**.
- Pick the brand the goods are bought for.
- Choose **Common — no brand** when they are for everyone. They then go to central stock.

**No brand box: the ERP works it out.**
- **GRN:** the goods go to the PO's brand. If the PO has none, they go to the brand of the MO the indent was raised for, then to the style's brand, and otherwise to central stock.
- **Finished goods received:** they go to the MO's brand, otherwise the sales order's.
- **Delivery challan:** the goods go out from the order's brand first.
  - Any shortfall comes from free central stock, moved to the brand automatically.
  - Another brand's earmarked stock is never sent: the challan is refused and names whose stock it is.

**Opening stock.** Inventory → Stock → **Opening Stock** → **Import from Excel**.
- The sheet has an optional **Brand** column. Filled in, the stock comes in earmarked for that brand; left empty, it goes to central stock.
- Stock typed in by hand always goes to central. Earmark it afterwards (section 2).

## 2. Moving stock between brands: Brand Stock

Inventory → Stock → **Brand Stock**. Each line shows:
- the **Brand** it is about: grey for central stock, blue for a brand, and both for a move;
- **What happened**, in plain words, for example "Set aside out of central stock" or "From central stock, for challan DC-…";
- the item, with its quantity.

**Brand** at the top shows one brand's lines only. **Show** picks:
- what people raised (the default);
- what waits for approval;
- the automatic moves made by MOs and challans;
- what was refused, withdrawn or reversed;
- or all of it.

The search box finds a number, an item, an MO or a challan.

| Kind | From → to | Use it when |
| --- | --- | --- |
| **Earmark for a brand** | central → a brand | central stock is set aside for one brand's work |
| **Move between brands** | one brand → another | a brand needs stock another brand holds |
| **Release to central** | a brand → central | a brand no longer needs what it holds |

**Raising one**

1. Click **Earmark, move or release**, and pick the kind.
2. Fill **Store**, **From brand** and **To brand**, and **Why** (at least 5 characters).
3. Add each item with its **Quantity**. Use **Another item** for more lines.
4. If the stock is on roll stickers, tick the **rolls**. The last roll ticked can go in part. For garments with tags, scan the tags of the pieces moving.
5. Click **Raise for approval**.

Nothing moves on the rack. The stock changes hands only when it is approved.

**Approving**
- Someone with the Brand Stock approval right, other than the person who raised it, clicks **Approve and post** or **Refuse**.
- The person who raised it can **Withdraw** it while it waits.
- An Admin may use **Approve my own (override)**, with a reason of at least 10 characters. The list marks it "override".
- A posted move can be undone with **Reverse**, unless the stock has been used since.

**Automatic moves for an MO**

When an MO's materials are issued, the MO's brand uses its own share first. Free central stock then moves to the brand by itself, and these moves show as "Automatic". This happens only when:
- the MO is authorised: released, or in cutting, stitching, finishing, QC or packing, and not on hold;
- its requisition is approved;
- the quantity is within the MO's material plan plus any approved extra material.

Anything else is refused. In that case, earmark the stock first, then issue it. An automatic move cannot be reversed by hand.

**Good to know**
- Stock on roll stickers must have its rolls named. If they are not named, the request is refused at approval with "STICKERS_NEEDED". Withdraw it and raise it again with the rolls ticked.
- Older stock is taken first (first in, first out) within each share. Another brand's older roll does not block yours.

## 3. Extra material for an MO

An MO gets only the material its plan allows. More than that, or a material the plan does not list, needs an approved extra.

**Asking:** Production → Manufacturing Orders → open the MO → **Materials** → **Extra material** → **Ask for extra**. This is available while the MO is released and not finished.
1. Pick the **Material**, from "On the plan" or "Not on the plan".
2. Fill **Why it is needed** and **How much more**.
3. Click **Ask for approval**.

**Approving:** a production manager other than the person who asked clicks **Approve** or **Turn down**. An Admin approves their own request only through **Approve my own (override)**, with a reason.

**Without approval:** issuing more than the plan is refused, with the message "Ask for extra material on the MO". An earmark alone does not allow it.

## 4. Inventory Matrix

Reports → Inventory → **Inventory Matrix — Company & Brands**. Like every report, it opens on its **Full Report**: one row for each item and share, where the **Share** column reads "Central" or the brand's name.

- **Filters:** As on (any date), Store, Brand, and What: Everything, Fabric, Thread, Raw materials (all), Semi-finished, Finished goods.
- **The Summary tab:**
  - **Headline figures:** Physical stock value, Central stock, Earmarked for brands, Free to use, WIP on floors, In transit.
  - **Stock value by brand:** the brands run across (Central stock, each brand, Company), and the kinds of stock run down: physical, raw and semi-finished, finished goods, WIP, rejected and held, in transit, reserved, free to use, and issued to open MOs. Central plus the brands always equals the company.
  - **Each item by brand:** every item, with its design and colour, showing how much is central stock and how much each brand's, then the total. Switch between **Quantity** (in the item's own unit) and **Value ₹**, and search for an item, design or colour.
- **Export:** PDF / Print, Excel or CSV.

Customers' own material is left out, because it is not ours. A "Shares below nothing" warning means a share went below zero: run Stock Reconciliation (section 8).

## 5. Profit centres and cost centres

- **Profit centres are the brands:** Masters → In House Brands → **Profit centre**. Left blank, it takes the brand name.
- **Cost centres are the departments:** Masters → Departments. **Rolls up into** groups them. The **Cost centres** button adds the standard ones: Production, Quality Control, Administration, Purchase, Sales & Marketing, Maintenance and Shared Overheads.
- **On a voucher** (Accounts → Day Book): income and expense lines have **Brand** and **Department**. A blank brand shows as "Not split", and a blank department as "No department".
- **Defaults save typing:**
  - a ledger can have a **Usual brand** and a **Usual department**;
  - an expense head (Masters → Expense Heads) can have a **Usual department**, for example Factory power → Production.
- **On purchase bills,** every expense line needs a department. The brand may be "shared".
- **Reports → Accounts:** Unallocated Entries (lines still missing a brand or department), Cost Centre Expenses, and the Expense Allocation Register.

## 6. Sharing expenses between brands

Accounts → **Expense Allocation**, with tabs **Rules** and **Months**.

**Rules (set up once):** **New rule**, then fill:
- **Name**;
- **Split by**: Sales that month, Pieces produced that month, Material consumed that month, Machine hours (typed each month), Fixed percentages, or Percentages typed on the run;
- **Order**;
- the **Expense ledgers it covers** and **Departments it covers** (blank means all);
- the **Brands that share** (blank means all);
- the **Share %**, where fixed (the "Makes" row must reach exactly 100%);
- **In use**.

Then click **Save rule**. Each shared expense goes to the first rule in order that covers it.

**Each month**
1. On **Months**, pick the month and click **Work it out**.
2. Check "Split by the rules", and "Left shared (no rule covers it)" for anything no rule covers.
3. Click **Save as a draft run**.
4. Someone other than the person who worked it out clicks **Approve**.
5. Click **Post to the books**. This writes one journal on the month's last day. It works only once the month has ended, and never in a closed period.
6. If an expense was booked or changed after the working-out, approval waits: click **Work out again**.
7. To undo a posted run, **Reverse** it (**Reverse the split**). This writes a journal numbered with "-R", and the month can be run again.

## 7. The P&L by brand

Accounts → **Profit & Loss**, set out the SAB and Tally way.

- **Two accounts, two sides each.**
  - The **Trading Account** puts opening stock, purchases and direct expenses (To) against sales, direct incomes and closing stock (By), down to gross profit.
  - The **Profit & Loss Account** puts indirect expenses (To) against gross profit and indirect incomes (By), down to net profit.
  - Each side of each account totals the same.
- **Whose:** pick **Company**, **Brand-wise** or **Department-wise**, then the brand or department.
- **A brand's stock is its own share.**
  - Stock it took from central stock or another brand is **To Stock moved in**.
  - Stock it gave up is **By Stock moved out**, at the value it moved at, so an earmark never changes anyone's profit.
- **Not split** is central stock, plus expenses not yet shared out. The brands and Not split add up to the company.
- **Ledgers:** click a heading to see them; a ledger opens its statement.
- **On a phone** the two sides stack: To first, then By, each with its total.
- **Export:** Excel or CSV, in the same two-sided form.
- Post the month's expense allocation first (section 6), so shared expenses reach the brands.

The sidebar item "VHAGAR Brand → Brand P&L" is a placeholder for a later screen. Use Profit & Loss → Brand-wise.

## 8. Checks and controls

- **Stock Reconciliation:** Reports → Inventory → **Stock Reconciliation**.
  - An empty report means stock, stickers, tags, cartons and holds all agree, share by share.
  - Each finding (Below zero, Value on nothing, Stickers over, Tags over, Cartons over, Holds over) has a **What to do** column.
- **A voucher's history:** open the voucher (Accounts → Day Book). Its window shows Details, Entries, Narration and **History**.
  - History lists each change with who made it, when, why, and what changed, for example "Amount ₹1,500.00 → ₹1,800.00".
  - **Show the voucher as it was before this** opens the earlier version.
  - A reversed voucher says which entry reversed it, and the two open each other.
- **Correcting a voucher:**
  - **Alter** it, giving a reason;
  - or **Reverse** it, which writes a reversing entry on a date you choose, with a reason of at least 5 characters, linked to the original.
  - Vouchers are never deleted.
- **Closed periods:** Accounts → Chart of Accounts → **Books**.
  - **Closed up to** freezes everything before that date.
  - Reopening needs the right "Reopen closed periods" and a reason under "Why is the closed period being reopened?". Every administrator is told.
  - The history is under "The books' dates, as they were changed".
- **Rights given by name only:** Settings → People → **Roles & access** → open the role.
  - **Override Sales Charge GST**, under Sales;
  - **Reopen closed periods**, under Accounts.
  - Neither comes with Sales-wide or Accounts-wide access: each must be ticked by name.
  - Approvers also need the Brand Stock or Expense Allocation approval rights.
