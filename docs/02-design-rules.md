# Design rules

Four people writing screens will produce four different-looking apps unless the
choices are already made. They are made. This file is where they are written
down.

**The one rule:** you do not choose colours, fonts, sizes or corners. They are
chosen. You use them.

Everything here already exists in two files:

- [apps/web/tailwind.config.js](../apps/web/tailwind.config.js) — the palette, fonts, shadows, animations
- [apps/web/src/app/globals.css](../apps/web/src/app/globals.css) — the theme and the ready-made classes

---

## 1. Colour

### Never write a colour

Not a hex code. Not `bg-blue-500`. Not a colour typed into a style attribute.

Use the named roles. They already handle dark mode and light mode:

| Class | What it is | Use it for |
|---|---|---|
| `bg-background` | The page | Page background |
| `text-foreground` | Main ink | Body text, table cells, headings |
| `text-muted-foreground` | Faded ink | Labels, hints, timestamps, empty states |
| `bg-card` | Raised surface | Panels sitting on the page |
| `border-border` | Divider line | Card edges, table row lines |
| `bg-secondary` | Quiet fill | Input backgrounds, inactive chips |
| `bg-primary` / `text-primary` | Teal | The main action, active state, links |
| `bg-accent` / `text-accent` | Amber | Attention, warnings, the AI assistant |
| `bg-destructive` | Red | Delete, danger |

### The brand colours

Three, and only three.

| | Colour | Means |
|---|---|---|
| **Teal** | `teal-400` … `teal-600` | The product. Primary buttons, active menu item, links, focus rings. |
| **Amber** | `amber-400` … `amber-600` | Attention. Pending, warning, the AI assistant. |
| **Navy / slate** | `navy-500` … `navy-900` | The furniture. Sidebar, backgrounds, borders. |

Status colours are fixed too:

| Meaning | Colour | Class |
|---|---|---|
| Good, done, approved, in stock | Emerald | `badge-success` |
| Waiting, pending, low stock | Amber | `badge-warning` |
| Failed, rejected, overdue, out of stock | Red | `badge-danger` |
| Information, draft, neutral note | Teal | `badge-info` |
| Inactive, cancelled, nothing happening | Slate | `badge-neutral` |
| Special (job work, external) | Purple | `badge-purple` |

Nothing else. No blue, no pink, no indigo, no plain green. If a new state seems
to need a colour, reuse one of the six or raise it with the team.

### Light mode

Every screen must work in both themes. This is not optional — the mill office is
bright and staff will switch.

The rule that makes it work: **a colour is defined once, as a variable, in
[globals.css](../apps/web/src/app/globals.css).** Never in a component.

If you find yourself typing a colour inside a component, stop. Either use an
existing role class, or add the variable to both `:root` and `.light` in
globals.css.

Watch for the trap: colours tuned for a dark card go invisible on white. Bright
teal and amber both fail on white, which is why light mode darkens them. If you
add a colour, look at it in both themes before raising the PR.

### The only exception

Charts. Chart libraries need real colour codes, so chart code uses hex. Take
them from the shared dashboard kit,
[components/dashboard/DashKit.tsx](../apps/web/src/components/dashboard/DashKit.tsx)
(`PALETTE` for data, `TONE` for figure tiles), which every dashboard is drawn
from, so the charts read as one family. A colour the kit does not have is named
once at the top of the chart file, never typed inline.

---

## 2. Type

One font: **Inter**. Loaded in globals.css. Code and figures that must line up
use **JetBrains Mono** (`font-mono`).

### Sizes

Six sizes exist. In an ERP the screen is dense, so the workhorse is the small
one, not the medium one.

| Class | Size | Use |
|---|---|---|
| `text-xs` | 12px | **The default.** Table cells, labels, badges, hints, most of the app. |
| `text-sm` | 14px | Form inputs, buttons, body copy, dialog text. |
| `text-base` | 16px | Almost never. |
| `text-lg` | 18px | A section heading inside a page. |
| `text-xl` | 20px | Rare. |
| `text-2xl` | 24px | The page title. One per screen. |

Nothing above `text-2xl` anywhere in the app. No giant hero text — this is a
working tool, not a landing page.

### Weights

Four, and one of them is the default you never type.

| Class | Use |
|---|---|
| (nothing) | Body text |
| `font-medium` | Labels, menu items, quiet emphasis |
| `font-semibold` | Headings, buttons, table headers, anything that must be noticed |
| `font-bold` | Page titles and KPI numbers only |

### Case

Table headers are upper case with wide letter spacing — that is built into
`.data-table`, you get it free. Nothing else is upper case. Do not shout in
buttons.

---

## 3. Spacing, corners, icons

### Spacing

Use the scale. Nothing else.

| Class | Use |
|---|---|
| `gap-1` / `gap-1.5` | An icon next to its own text |
| `gap-2` | Items inside a group — buttons in a row, badge and label |
| `gap-3` | Fields in a form, rows in a list |
| `gap-4` | Between blocks inside a card |
| `gap-6` | Between cards on a page |

Padding follows the same scale: `p-3` inside small things, `p-5` in a KPI card,
`p-6` inside a card body, `px-6 py-4` in a card header.

Never an arbitrary value like `gap-[7px]` or `p-[13px]`.

### Corners

| Class | Use |
|---|---|
| `rounded-lg` | **The default.** Buttons, inputs, panels, menu items. |
| `rounded-xl` | Cards (`glass-card` applies it for you) |
| `rounded-full` | Badges, avatars, pills |

Never `rounded-md`, `rounded-sm`, `rounded-none` or a custom radius.

### Icons

Icons come from `lucide-react`. Nothing else — no emoji in the interface, no
second icon pack.

| Size | Use |
|---|---|
| 13 or 14 | Inside a badge or a table cell |
| 15 or 16 | **The default.** Buttons, form fields, notices. |
| 18 | Sidebar navigation, page-header actions |

Anything larger is decoration and probably should not be there.

---

## 4. Use what exists

Most screens should be assembled, not written. Before you build anything, check
this list.

### Ready-made CSS classes

Defined in [globals.css](../apps/web/src/app/globals.css). Type the class, get
the design.

| Class | What it gives you |
|---|---|
| `glass-card` | The standard panel — blur, border, shadow, rounded |
| `kpi-card` | A dashboard number tile |
| `page-header` / `page-title` / `page-subtitle` | The top of every screen |
| `data-table` | A whole table styled — header, rows, hover, dividers |
| `btn-primary` | The main action (teal, glowing) |
| `btn-secondary` | The second action |
| `btn-ghost` | A quiet action — icons, "cancel" |
| `btn-danger` | Delete, deactivate |
| `form-input` / `form-label` | Every field on every form |
| `badge-success` … `badge-purple` | Every status pill |
| `nav-item` | A sidebar row |
| `skeleton` | The shimmer shown while loading |
| `divider` | A horizontal rule |

Never re-style a button with raw Tailwind. `btn-primary` exists.

### Ready-made components

| Component | File | What it does |
|---|---|---|
| `MasterTable` | [masters/MasterTable.tsx](../apps/web/src/components/masters/MasterTable.tsx) | A complete master screen — list, search, sort, pages, add, edit, deactivate. Give it columns and fields. |
| `MasterFormDialog` | [masters/MasterFormDialog.tsx](../apps/web/src/components/masters/MasterFormDialog.tsx) | A create/edit form built from a list of fields. Handles dropdowns fed from the API, field errors, saving. |
| `SettingsCard`, `Field`, `Notice`, `SaveButton`, `Toggle`, `LoadingRow` | [settings/ui.tsx](../apps/web/src/components/settings/ui.tsx) | The pieces every settings screen is made of. |
| `PrintSheet`, `DocumentTable`, `PrintToolbar`, `money` | [print/PrintSheet.tsx](../apps/web/src/components/print/PrintSheet.tsx) | A printable A4 document. |
| `cn`, `formatCurrency`, `formatDate` | [lib/utils.ts](../apps/web/src/lib/utils.ts) | Joining class names, money, dates. |
| `useAppSettings` | [lib/appSettings.ts](../apps/web/src/lib/appSettings.ts) | The user's saved preferences — rows per page, date format. |

**A whole master screen is about thirty lines.** If yours is three hundred, you
are rebuilding something that already exists.

### Never do these

- Never format money by hand. `formatCurrency()` on screen, `money()` on print.
- Never format a date by hand. `formatDate()` — it obeys the user's setting.
- Never build your own pagination, search box or sort arrows.
- Never install a UI kit. No Material, no Chakra, no Bootstrap, no daisyUI.
- Never add an animation library. What is in tailwind.config.js is enough.

---

## 5. How a screen is laid out

Every screen has the same skeleton: a page header with the title on the left and
the main action on the right, then content in `glass-card` panels, spaced with
`space-y-6`.

Copy an existing screen rather than starting from nothing. A good one to copy is
the suppliers page, at `apps/web/src/app/(dashboard)/masters/suppliers/page.tsx`.

Forms are a two-column grid on a wide screen and one column on a narrow one
(`grid-cols-1 md:grid-cols-2 gap-4`). A field needing the full width gets
`md:col-span-2`, or `span: 2` if you are using `MasterFormDialog`.

### The four states

Every screen that loads data must handle all four. A screen missing one of them
is not finished.

| State | What to show |
|---|---|
| Loading | `LoadingRow` or `skeleton`. Never a blank screen. |
| Empty | A sentence saying what to do next. Never a bare "No data". |
| Error | The message the API sent, in a `Notice` of kind `error`. Never "Something went wrong". |
| Loaded | The data. |

---

## 6. Words

The people using this are mill staff, not developers. Write for them.

| Do not write | Write |
|---|---|
| Invalid GSTIN | That GSTIN does not look right. It should be 15 characters, like 27AABCU9603R1ZM. |
| Error 500 | Could not save the order. Try again, or call support if it keeps happening. |
| Field is required | Choose a supplier |
| Entity deleted successfully | Supplier deactivated |
| Submit | Save order |
| No data | No orders yet. Create one to get started. |

Rules:

- Say what to do next, not only what went wrong.
- Buttons say the verb: **Save order**, **Receive goods**, **Print**. Never "Submit" or "OK".
- Use the mill's words — supplier, lot, challan, job worker. Not "vendor entity".
- No developer words on screen: null, undefined, exception, payload, endpoint.

---

## 7. Printed documents are different

Print is not the app. It is black ink on white paper, and it has to survive a
laser printer and a GST officer.

Rules for anything under `app/(print)/`:

- Black on white. No theme, no dark mode, no glass, no shadow.
- Inline styles, not Tailwind classes. The printed page must not depend on the app stylesheet.
- No sidebar and no top bar — that is exactly why print pages sit in their own route group.
- Column widths are **weights**, which `DocumentTable` turns into percentages. Never fixed pixels. Fixed pixels are what made the table cover half the sheet.
- Use `PrintSheet` and `DocumentTable`. Do not hand-build a table.

The purchase order print page is the pattern to copy.

---

## 8. Before you raise the PR

- [ ] No hex colour outside chart code
- [ ] No Tailwind colour outside teal / amber / navy / slate / emerald / red / purple
- [ ] Every colour I used is a role class or a variable
- [ ] I opened the screen in light mode and it is readable
- [ ] I narrowed the window and nothing overlaps or overflows
- [ ] Text sizes are `text-xs` or `text-sm`, except one `text-2xl` page title
- [ ] Corners are `rounded-lg`, `rounded-xl` or `rounded-full`
- [ ] Buttons use `btn-*`, badges use `badge-*`, inputs use `form-input`
- [ ] Loading, empty and error states all exist
- [ ] Every message is something a mill clerk could act on
