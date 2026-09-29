'use client'

import { useCallback, useEffect, useState } from 'react'
import { useParams, useSearchParams } from 'next/navigation'
import { api, ApiError } from '@/lib/api'
import { PrintToolbar, money } from '@/components/print/PrintSheet'

/**
 * The printed purchase order.
 *
 * Rebuilt to the layout he supplied on 17 Sep 2026: navy and a pale navy
 * tint, a heading strip on every block, the logo on the letterhead, and the
 * two figures a supplier quotes back — the number and the date — in a filled
 * box of their own.
 *
 * ── Pagination is ours, not the browser's ───────────────────────────────────
 *
 * The lines are split into sheets here and each sheet is its own block with a
 * page break after it. That costs a little arithmetic and buys the two things
 * a browser cannot give you: a real "Page 1 of 2", and a header band repeated
 * at the top of the second sheet naming the order it belongs to. Left to the
 * browser, a long order spills onto a second page carrying no clue which
 * order it is — and a loose sheet on a mill floor with no order number on it
 * is a sheet nobody can act on.
 *
 * ── What fits, and how it is worked out ────────────────────────────────────
 *
 * Not a row count. The first sheet is a race between the item lines and the
 * calculation beside them, and the calculation carries a row for every charge
 * the mill puts on a purchase — so the answer moves with the charge master.
 * It is worked out from four measured heights: see the note on A4_PX,
 * SHEET_CHROME, LINE_ROW and CHARGE_ROW further down, and
 * ROWS_ON_FIRST_OF_TWO for the sheet that has the closing block overleaf.
 *
 * Erring low costs white space at the foot of a page. Erring high means the
 * browser inserts a break of its own, and then "Page 1 of 1" is a lie printed
 * on paper — which is the failure this whole file exists to avoid.
 *
 * If more lines per sheet are wanted, the room is in the charge rows and the
 * terms: five charges are about 115px of an 1122px page, and the terms
 * another 110px. Both are a decision about the document rather than a tweak
 * to this file — the charges come from Masters -> Charges.
 *
 * ── The rules this sheet is held to ─────────────────────────────────────────
 *
 * - **Inter, and nothing else.** No second family, and — since 17 Sep — no
 *   monospace either: figures are the body face with `tabular-nums`, which
 *   keeps the columns straight without making the sheet read like a terminal.
 *   See the note on NUM. Identifiers get a little tracking instead, via CODE.
 * - **Inline styles only, except the two things that cannot be.** See
 *   SHEET_CSS: a page box and a print-colour instruction are properties of
 *   the paper, not of an element. Everything else is inline, because the app
 *   has a dark theme and a stylesheet that reached the printer would take it
 *   there.
 * - **Percentage column widths, never pixels.** Fixed pixels are what once
 *   made this table cover half the sheet.
 * - **Navy on white, and one tint.** Every filled band on the sheet is either
 *   NAVY or TINT; there is no third colour. Note that this navy is a truer
 *   blue than the "navy" in the screen palette, which is really slate — see
 *   the note on the constant.
 */

interface Line {
  id: string
  description: string | null
  /**
   * The garment this material is being bought for.
   *
   * `styleNo` is what the buyer typed and is always there when they entered
   * one; `style` is the master it resolved to, set only when the text matched
   * a style's code exactly. The text is printed in preference to the code,
   * because the text is what the buyer and the supplier agreed on — and on a
   * purchase order it is often a style the mill has not set up yet, in which
   * case there is no code at all.
   */
  styleNo: string | null
  style: { code: string; name: string } | null
  hsnCode: string | null
  qty: string
  unitRate: string
  discount: string
  gstRate: string
  amount: string
  item: {
    code: string
    name: string
    uom?: { symbol: string } | null
    /// An item sits at whichever level it was filed under, so the parent is
    /// the category and the item's own is the subcategory — the same way round
    /// the form and the orders list read them.
    category?: { name: string; parent?: { name: string } | null } | null
  }
}

interface PrintPayload {
  company: Record<string, string | null>
  template: {
    title: string
    termsText: string | null
    declaration: string | null
    footerNote: string | null
    showHsn: boolean
    showAmountInWords: boolean
    showSignature: boolean
    copies: string[]
  }
  order: {
    poNumber: string
    poDate: string
    poType: string | null
    /// The supplier's own quotation this order answers. First thing anyone
    /// reaches for when a price is queried months later, and the reason the
    /// field was added to the form.
    enquiryNo: string | null
    enquiryDate: string | null
    reference: string | null
    /// The supplier's address as it read when the order was raised.
    supplierAddress: string | null
    notes: string | null
    terms: string | null
    subtotal: string
    discountAmount: string
    taxableAmount: string
    cgst: string
    sgst: string
    igst: string
    roundOff: string
    otherCharges: string
    /// Transport, freight, dyeing. Printed because the supplier is being asked
    /// to invoice them, and a total that included charges the sheet did not
    /// name would be queried on every order.
    charges: {
      amount: string
      gstRate: string
      chargeType: { name: string }
    }[]
    totalAmount: string
    supplier: Record<string, string | null> & { creditDays?: number | null }
    deliveryWarehouse: { name: string; address: string | null } | null
    deliveryCustomer: { name: string; code: string; gstin: string | null } | null
    deliveryAddress: string | null
    createdBy: { name: string } | null
    lines: Line[]
  }
  totalInWords: string
  taxMode: 'IGST' | 'CGST_SGST' | 'NONE'
}

/*
 * What fits on a sheet, measured in pixels rather than guessed in rows.
 *
 * The first sheet is a race between two things of different heights: the item
 * lines, and the calculation beside them — which carries one row per charge
 * the mill puts on a purchase, and those rows print whether the order used
 * them or not. A single "lines that fit" number cannot describe that, and the
 * two it replaced were wrong in both directions: 9 and 13 were arrived at
 * from an assumed row height, and PROJECT_STATUS said in as many words that
 * nobody had printed a long order to check. A nine-line order came out of the
 * printer on two sheets with "Page 1 of 1" on the first.
 *
 * So these four numbers were measured instead — the sheet rendered at 210mm
 * in headless Chrome, its own height read off the pixels, then checked
 * against the page count of the PDF Chrome produced, which is the only test
 * that counts:
 *
 *   lines   charges   sheet 1   result
 *   1       5         1123      fits (at the 297mm minimum)
 *   2       5         1158      over by 36
 *   3       5         1201      over by 79
 *
 * which gives a line row of about 43px and, with the charge rows tightened to
 * 22px, the chrome below.
 *
 * If a break ever falls in the wrong place: render the sheet, measure it,
 * print it to PDF and move these. Do not reason about them.
 */

/** A4 at 96dpi, less a pixel so a rounded fraction cannot spill a page. */
const A4_PX = 1122

/**
 * Everything on the first sheet that is neither an item line nor a charge
 * row: the letterhead, the "To," block, the delivery band, the table's head,
 * the amount in words, the tax rows, the terms, the signatures, the footer.
 */
const SHEET_CHROME = 957

const LINE_ROW = 43
const CHARGE_ROW = 23

/**
 * The most rows the first of two sheets can take.
 *
 * Higher than the figure above because the closing block has gone overleaf —
 * this sheet is the letterhead, the panels and the table, and nothing else.
 * Unaffected by the charges, which are all in the block that moved.
 */
const ROWS_ON_FIRST_OF_TWO = 13

/*
 * Navy and a pale navy tint.
 *
 * This sheet was black on white, and the note that used to sit here said blue
 * was not a colour this system had. It is his sheet and his supplier reading
 * it, and he asked for this one — so the colour is here, defined once, and
 * every band on the paper is either NAVY or TINT. Swapping those two lines
 * swaps the whole document back.
 *
 * Worth knowing: `#173a6c` is a truer blue than the "navy" in
 * tailwind.config.js, which is really slate (`#1e293b`). The screen palette in
 * docs/02-design-rules.md does not have this colour in it. Printed paper is
 * not a screen and this is one document, but if the two should match, this is
 * the constant to change.
 */
const NAVY = '#173a6c'

/* The pale fill behind every heading strip, the table head and the P.O. box. */
const TINT = '#e9eff8'
/* The alternate row in the totals, a step paler again. */
const TINT_SOFT = '#f4f7fc'

const INK = '#1f2b3d'
// Third pass, and the last one worth making: past this there is no grey left
// to remove and the labels would simply be the values.
//
// The lesson each time was the same. These labels print at 9–10.5px, and a
// grey that reads comfortably at 14px backlit on a desk is not the same grey
// at 10px under a mill's strip lighting, photocopied. Screen judgement was
// the wrong instrument; the contrast figures were the right one.
//
// The hierarchy no longer rests on the label being faint. It rests on weight:
// labels regular, values bold and near-black. That survives a tired mono
// printer and a second-generation photocopy, which a pale grey does not.
const GREY = '#44536b'
// Still quieter than a real value, but no longer a smudge.
const MUTED = '#5a6880'
// The rules came up with the text, because they are the other half of why a
// sheet reads badly on paper. #d8d8d8 is 1.4:1 — on a screen it is a tidy
// hairline, and out of a mill's laser printer it is a dotted suggestion of a
// line. The table has to hold its columns together after a photocopy.
/*
 * The rules, in blue now but at the same lightness as the greys they replace.
 * That was the point of the greys: #d8d8d8 is 1.4:1, a tidy hairline on a
 * screen and a dotted suggestion out of a mill's laser printer. A blue chosen
 * by eye would have undone it, so these two were matched on luminance rather
 * than picked.
 */
const RULE = '#aebfd6'
const RULE_SOFT = '#cdd9ea'

/* Kept: the preview stamp is a warning about the sheet, not part of it. */
const AMBER = '#f59e0b'

/*
 * The variable first, then the literal name.
 *
 * Inter is loaded by `next/font/google` in the root layout, which does not
 * publish it under the name "Inter" — it generates a private family name and
 * hands it over as the custom property `--font-inter`. So a stack that asks
 * for `Inter` by name matches nothing unless the reader happens to have the
 * font installed, and this sheet has been setting in whatever the system
 * offers instead. Which is most of why the typography looked wrong: it was
 * not the typeface the rest of the product uses.
 *
 * Worth knowing that `tailwind.config.js` has the same literal in its `sans`
 * stack, so every screen in the ERP is likely doing the same thing. That is a
 * one-line fix in the Tailwind config and it changes the look of the whole
 * app, so it is not made here.
 */
const SANS = 'var(--font-inter), Inter, system-ui, sans-serif'

/**
 * "Packaging > Tapes" from whichever level the item was filed under.
 *
 * An item can sit on a parent category directly, in which case there is no
 * subcategory and the one name is the whole answer.
 */
function categoryPath(
  c?: { name: string; parent?: { name: string } | null } | null
): string | null {
  if (!c) return null
  return c.parent ? `${c.parent.name} › ${c.name}` : c.name
}

/**
 * Every figure on the sheet goes through here, so columns align.
 *
 * Tabular figures of the body face, not a monospace one.
 *
 * This sheet set every number in JetBrains Mono, and that one decision was
 * most of what made it read as a screen rather than a document: a code face
 * puts a purchase order in the same visual family as a terminal. The reason
 * given for it was that figures must line up down a column — which is exactly
 * what `tabular-nums` does, in Inter, without the borrowed voice. Inter ships
 * tabular lining figures; the columns are as straight as they were.
 *
 * Worth knowing that this is a deliberate departure from
 * docs/02-design-rules.md, which allows "the monospace stack for codes,
 * quantities, rates and GSTINs". That rule is written for the screens. On
 * paper the same choice reads as unfinished, and the rule's own justification
 * — alignment — is met the other way. If the two should agree, this is the
 * constant to change back.
 */
const NUM: React.CSSProperties = { fontVariantNumeric: 'tabular-nums' }

/**
 * An identifier rather than a quantity: an order number, a GSTIN, an item
 * code.
 *
 * Still the body face, with a touch of tracking. These are read a character
 * at a time — somebody checking a GSTIN against a bill reads it in pairs —
 * and a hair of space between the letters is what a code face was really
 * providing.
 */
const CODE: React.CSSProperties = { fontVariantNumeric: 'tabular-nums', letterSpacing: '.02em' }

/** The last column of the line table: the table's own border is already there. */
const LAST_CELL: React.CSSProperties = { borderRight: 'none' }

const shortDate = (v: string) =>
  new Date(v).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' })

/** A blank field is an em-dash, kept muted so it reads as "nothing here". */
function Dash() {
  return <span style={{ color: MUTED }}>—</span>
}

function Eyebrow({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div
      style={{
        /* 9px at .08em, not 8.5px at .16em.
           A sixth of an em between letters is a fashion, not a document: at
           this size it stops being a word and becomes a row of characters,
           and there are nine of these labels on the sheet. A point larger and
           half the tracking reads as a heading and is easier to read besides. */
        fontSize: '9px',
        fontWeight: 700,
        letterSpacing: '.08em',
        textTransform: 'uppercase',
        color: NAVY,
        ...style,
      }}
    >
      {children}
    </div>
  )
}

/**
 * The letterhead's little marks, and the one on the delivery band.
 *
 * Drawn here rather than imported. This page is deliberately inline styles and
 * nothing else — the app has a dark theme, and a stylesheet that reached the
 * printer would take it there — so an icon component that carries its own
 * classes is the one thing that cannot be used. Six outlines is less code than
 * the import would have been anyway.
 */
function Glyph({ name, size = 11 }: { name: GlyphName; size?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: NAVY,
    strokeWidth: 1.9,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    style: { flexShrink: 0, display: 'block' },
  }
  switch (name) {
    case 'mail':
      return (
        <svg {...common} aria-hidden>
          <rect x="2" y="4.5" width="20" height="15" rx="2" />
          <path d="m2.8 6 9.2 6.2L21.2 6" />
        </svg>
      )
    case 'phone':
      return (
        <svg {...common} aria-hidden>
          <path d="M21.5 16.9v2.6a2 2 0 0 1-2.2 2 19.6 19.6 0 0 1-8.5-3 19.3 19.3 0 0 1-6-6 19.6 19.6 0 0 1-3-8.6 2 2 0 0 1 2-2.2h2.6a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1l-1.1 1.1a15.8 15.8 0 0 0 6 6l1.1-1.1a2 2 0 0 1 2.1-.5c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2Z" />
        </svg>
      )
    /* GST and PAN are both registration numbers, so both are a seal: a ring
       with a mark in it. Different marks, because a supplier scanning the
       letterhead for one of the two should not have to read the label. */
    case 'gst':
      return (
        <svg {...common} aria-hidden>
          <circle cx="12" cy="12" r="9" />
          <path d="M9.5 8h5M9.5 11h5M13 15.5 9.5 11h1.8c2.6 0 2.6-3 0-3" />
        </svg>
      )
    case 'pan':
      return (
        <svg {...common} aria-hidden>
          <circle cx="12" cy="12" r="9" />
          <circle cx="12" cy="10" r="2.4" />
          <path d="M7.8 17.3a4.6 4.6 0 0 1 8.4 0" />
        </svg>
      )
    case 'web':
      return (
        <svg {...common} aria-hidden>
          <circle cx="12" cy="12" r="9" />
          <path d="M3 12h18M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18Z" />
        </svg>
      )
    case 'truck':
      return (
        <svg {...common} aria-hidden>
          <path d="M2 7.5h10v9H2zM12 10.5h4.6l2.9 3v3H12z" />
          <circle cx="6" cy="18" r="1.8" />
          <circle cx="16.5" cy="18" r="1.8" />
        </svg>
      )
  }
}

type GlyphName = 'mail' | 'phone' | 'gst' | 'pan' | 'web' | 'truck'

/**
 * One line of the letterhead: a mark, a label, a colon, the value.
 *
 * The colon sits in its own cell rather than being stuck to the end of the
 * label, which is the only way five labels of different lengths line their
 * values up down a column.
 */
function HeadRow({
  icon,
  label,
  value,
  mono,
}: {
  icon: GlyphName
  label: string
  value: string | null
  mono?: boolean
}) {
  // 1.62, not 1.85. The letterhead went from five rows to six when TIN No went
  // back on it, and that row cost the sheet the twenty pixels a two-line order
  // needed to stay on one page. Taken back out of the leading, where nobody
  // will miss it, rather than out of a block that has something in it.
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '7px', lineHeight: 1.5 }}>
      <Glyph name={icon} />
      <span style={{ fontSize: '9.5px', color: GREY, width: '52px', flexShrink: 0 }}>{label}</span>
      <span style={{ fontSize: '9.5px', color: MUTED, flexShrink: 0 }}>:</span>
      <span
        style={{
          fontSize: '10.5px',
          fontWeight: 600,
          color: INK,
          ...(mono && value ? NUM : {}),
        }}
      >
        {value || <Dash />}
      </span>
    </div>
  )
}

/**
 * A titled block: a tinted strip with the title, and the body under it.
 *
 * The title used to sit inside the body's padding, which left the reader
 * working out where one block stopped and the next began from an 8.5px line of
 * capitals. A filled strip is the cheapest way to say it.
 */
function Panel({
  title,
  children,
  style,
  bodyStyle,
}: {
  title: string
  children: React.ReactNode
  style?: React.CSSProperties
  bodyStyle?: React.CSSProperties
}) {
  return (
    <div style={{ border: `1px solid ${RULE}`, ...style }}>
      <div
        style={{
          background: TINT,
          borderBottom: `1px solid ${RULE}`,
          padding: '5.5px 11px',
        }}
      >
        <Eyebrow>{title}</Eyebrow>
      </div>
      <div style={{ padding: '6px 11px', ...bodyStyle }}>{children}</div>
    </div>
  )
}

/**
 * One line of the "To," block: a bold label with its value run on after it.
 *
 * The mill's old sheet sets these out as flowing text rather than as a table
 * of label and value columns — "GST No  27AFXPT0531P1ZK", the address running
 * across two lines under "Address-". Kept that way because it is what he
 * calls the professional one, and because an address is the one field here
 * that genuinely needs the full width to itself.
 */
function ToLine({ label, value, mono }: { label: string; value: string | null; mono?: boolean }) {
  return (
    <div style={{ fontSize: '10.5px', lineHeight: 1.55, marginTop: '2px' }}>
      <span style={{ fontWeight: 700, color: NAVY }}>{label}</span>
      <span
        style={{
          color: INK,
          marginLeft: '8px',
          ...(mono && value ? CODE : {}),
        }}
      >
        {value || <Dash />}
      </span>
    </div>
  )
}

/**
 * One line of the block beside it: label, colon, value.
 *
 * The colon sits in a column of its own so the values line up under each
 * other, which they have to — this is where somebody looks to quote the order
 * number back at us.
 */
function PoLine({ label, value, mono }: { label: string; value: string | null; mono?: boolean }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'auto 8px auto',
        alignItems: 'baseline',
        gap: '10px',
        marginTop: '2px',
      }}
    >
      <span style={{ fontSize: '10.5px', fontWeight: 700, color: NAVY }}>{label}</span>
      <span style={{ fontSize: '10px', color: MUTED }}>:</span>
      <span
        style={{
          fontSize: '11px',
          fontWeight: 700,
          color: NAVY,
          ...(mono && value ? CODE : {}),
        }}
      >
        {value || <Dash />}
      </span>
    </div>
  )
}

/**
 * One line of the calculation.
 *
 * Striped, because this is the block a supplier's accounts clerk reads across
 * rather than down — label on the left, figure hard right, and nine of them on
 * a wide box is where an eye loses its line.
 *
 * `alt` rather than an `:nth-child` rule: this page has no stylesheet to put
 * one in, and the rows are built from three separate conditionals, so a
 * counter passed down is the only thing that knows which row this really is.
 */
function TotalRow({ label, value, alt }: { label: string; value: string; alt: boolean }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr) 9px 84px',
        alignItems: 'baseline',
        gap: '8px',
        /* 4.5px, not 6.5. The calculation carries a row per charge the mill
           uses, and with five of them the block grew past the page. Taken out
           of the row padding, where 22px still reads comfortably at 11px,
           rather than out of the type. */
        padding: '4.5px 11px',
        fontSize: '11px',
        color: GREY,
        background: alt ? TINT_SOFT : '#fff',
      }}
    >
      <span>{label}</span>
      <span style={{ fontSize: '10px', color: MUTED }}>:</span>
      <span style={{ color: NAVY, fontWeight: 600, textAlign: 'right', ...NUM }}>{value}</span>
    </div>
  )
}

/* ── The line table, used on both sheets ──────────────────────────────────── */

/*
 * Color is gone. It was in the design we were handed, but there is no colour
 * field on an order line, so it printed an em-dash on every row of every sheet
 * — a column whose only content was the news that it had no content.
 *
 * Its 8% went to Code, and that is what pays for the category line below.
 * "PKG-TAPE-001" was wrapping to two lines in 12%, so every row was already
 * two lines tall because of the code, while Description used only one. Giving
 * Code enough width to sit on one line frees the second line of the row for
 * the category, and the row height does not change. The page breaks are
 * counted in rows, so a taller row would have cost lines off every sheet.
 */
/*
 * Eleven columns, which is every column the mill's old sheet had plus the HSN
 * this one adds.
 *
 * Style No. is the one that was genuinely missing: the order has carried it
 * since the form gained the field, and the paper never showed it. A supplier
 * reading a label order without the style has to ring up and ask which shirt
 * it is for.
 *
 * Colour is here because the old sheet has the column and he asked for every
 * field on it. Nothing fills it yet — there is no colour on a purchase order
 * line, which is also why it printed empty on the old system. It is kept
 * narrow for that reason: enough to hold a colour when there is one to hold,
 * not enough to cost another column its room.
 *
 * Description gives up room for both. At 21% it is about 150px, which holds
 * the item name on one line and wraps the filing line beneath it — and the
 * page-break numbers below were re-measured after this change, because a
 * taller row is fewer rows to a sheet.
 */
const COLS = [
  { w: '4%', label: 'S.N', align: 'center' as const },
  // 26% is about 173px of content, which is what the filing line underneath
  // the item name needs to stay on one line. At 21% it took two lines, the
  // name took two, and every row was four lines and 73px tall — which cost
  // the first sheet four of its rows. Width here is the cheapest thing on
  // the table.
  { w: '26%', label: 'Description', align: 'left' as const },
  // Narrow on purpose: nothing fills it yet, and every percent it takes comes
  // off a column that has something in it. Wide enough for its own heading
  // and a short colour name; widen it the day a purchase order line can
  // carry one.
  { w: '6%', label: 'Color', align: 'left' as const },
  // 14%, which is 88px of content. 'LBL-CARE-001' is twelve characters and
  // came to about 80 once the figures moved off the monospace face — at 12%
  // every code in the master broke across two lines, and a wrapped code is
  // the one thing on this row somebody has to read exactly.
  { w: '14%', label: 'Item Code', align: 'left' as const },
  { w: '8%', label: 'Style No.', align: 'left' as const },
  { w: '5%', label: 'HSN', align: 'left' as const },
  { w: '8%', label: 'Qty', align: 'right' as const },
  { w: '5%', label: 'UOM', align: 'center' as const },
  { w: '8%', label: 'Rate', align: 'right' as const },
  // 'Disc', not 'Disc. (₹)'. The longer heading did not fit its column and
  // broke over two lines, which made the whole header band taller for it. The
  // currency is not in doubt: the rate beside it and the amount after it both
  // carry the symbol, and the amount's heading names it.
  { w: '5%', label: 'Disc', align: 'right' as const },
  // Room for a real total: 67px of content holds ₹12,84,650.00 at 11px mono.
  { w: '11%', label: 'Amount (₹)', align: 'right' as const },
]

function LineTable({ lines, startIndex }: { lines: Line[]; startIndex: number }) {
  /*
   * A size down, and allowed to wrap.
   *
   * Eleven headings at 8.5px with .09em of tracking did not fit their columns
   * once Colour and Style No. went on: COLOR ran straight into ITEM CODE, and
   * AMOUNT (₹) was clipped off the right-hand edge — `nowrap` does not shrink
   * a heading, it just lets it overflow into the cell next door. Wrapping
   * costs the header band one extra line, once, instead of a wrong heading on
   * every sheet.
   */
  const th: React.CSSProperties = {
    padding: '5px',
    fontSize: '8px',
    fontWeight: 600,
    letterSpacing: '.04em',
    textTransform: 'uppercase',
    color: NAVY,
    background: TINT,
    borderRight: `1px solid ${RULE}`,
    lineHeight: 1.25,
  }

  /*
   * Ruled between the columns, not only under the rows.
   *
   * Nine columns of figures with horizontal rules alone is a reading test on
   * paper: a quantity and a rate three columns apart start to look like one
   * number with a gap in it. The vertical rules are what make a row scan
   * across, and they are why this table survives a photocopy well enough to
   * be argued from.
   */
  const td: React.CSSProperties = {
    padding: '5.5px 5px',
    fontSize: '11px',
    color: INK,
    borderTop: `1px solid ${RULE}`,
    borderRight: `1px solid ${RULE_SOFT}`,
    verticalAlign: 'top',
  }

  return (
    <table
      style={{
        width: '100%',
        borderCollapse: 'collapse',
        tableLayout: 'fixed',
        border: `1px solid ${RULE}`,
      }}
    >
      <colgroup>
        {COLS.map((c, i) => (
          <col key={i} style={{ width: c.w }} />
        ))}
      </colgroup>
      <thead>
        <tr>
          {COLS.map((c, i) => (
            <th
              key={i}
              style={{ ...th, textAlign: c.align, ...(i === COLS.length - 1 ? LAST_CELL : {}) }}
            >
              {c.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {lines.map((line, i) => (
          <tr key={line.id}>
            <td style={{ ...td, textAlign: 'center', color: MUTED, ...NUM }}>
              {startIndex + i + 1}
            </td>
            <td style={td}>
              <div style={{ fontWeight: 700, color: NAVY }}>{line.item.name}</div>
              {(() => {
                // Category and subcategory share one line with the line's own
                // note, because the row has exactly one line spare and both
                // are secondary to the item name.
                const filing = categoryPath(line.item.category)
                const parts = [filing, line.description].filter(Boolean)
                if (!parts.length) return null
                return (
                  <div
                    style={{
                      fontSize: '8.5px',
                      letterSpacing: '.03em',
                      textTransform: 'uppercase',
                      color: GREY,
                      marginTop: '1.5px',
                    }}
                  >
                    {parts.join(' - ')}
                  </div>
                )
              })()}
            </td>
            {/* Empty until a purchase order line can carry a colour, which
                is how it printed on the old system too. Not left out, because
                he asked for every field the old sheet had and a supplier used
                to reading that sheet looks for this column. */}
            <td style={{ ...td, fontSize: '10px', color: GREY }}>
              <Dash />
            </td>

            {/* Deliberately allowed to wrap. The column is wide enough for
                every code we have, and a longer one in future should take a
                second line rather than run into the column beside it.
                `break-word`, not `anywhere` — PROJECT_STATUS records a printed
                supplier address that came out one letter per line because
                `anywhere` lets a column collapse to a single character. */}
            <td style={{ ...td, ...NUM, fontSize: '10px', overflowWrap: 'break-word' }}>
              {line.item.code}
            </td>
            {/* What the buyer typed, or the master code when that is all
                there is. See the note on the field. */}
            <td style={{ ...td, fontSize: '10px', overflowWrap: 'break-word' }}>
              {line.styleNo || line.style?.code || <Dash />}
            </td>

            <td style={{ ...td, ...NUM, fontSize: '10.5px', color: GREY }}>
              {line.hsnCode || <Dash />}
            </td>
            <td style={{ ...td, ...NUM, textAlign: 'right', fontWeight: 700, color: NAVY }}>
              {money(line.qty)}
            </td>
            <td style={{ ...td, textAlign: 'center', color: GREY }}>
              {line.item.uom?.symbol || <Dash />}
            </td>
            <td style={{ ...td, ...NUM, textAlign: 'right' }}>₹{money(line.unitRate)}</td>
            <td
              style={{
                ...td,
                ...NUM,
                textAlign: 'right',
                color: Number(line.discount) > 0 ? INK : MUTED,
              }}
            >
              {Number(line.discount).toFixed(2)}
            </td>
            <td
              style={{
                ...td,
                ...NUM,
                ...LAST_CELL,
                textAlign: 'right',
                fontWeight: 700,
                color: NAVY,
              }}
            >
              ₹{money(line.amount)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/**
 * Where the goods go.
 *
 * This was missing from the sheet entirely, which is the worst of the gaps
 * the form had opened up: the order form can now send a purchase straight to
 * a customer, and the paper the supplier works from said nothing about it. A
 * supplier reading the old sheet would have shipped to the address in the
 * letterhead, which is us, and the goods would have gone to the wrong place.
 *
 * The delivery-to-customer case is called out rather than just named, because
 * it is an instruction that differs from what the supplier does every other
 * day of the week.
 */
function DeliverToBand({
  order,
  companyName,
  companyAddress,
}: {
  order: PrintPayload['order']
  companyName: string | null
  companyAddress: string | null
}) {
  const toCustomer = Boolean(order.deliveryCustomer)

  const name = order.deliveryCustomer
    ? order.deliveryCustomer.name
    : order.deliveryWarehouse
      ? order.deliveryWarehouse.name
      : companyName

  // The address frozen onto the order wins. A customer moves, and an order
  // already sitting with a supplier must not move under it.
  const address =
    order.deliveryAddress ||
    order.deliveryWarehouse?.address ||
    (toCustomer ? null : companyAddress)

  if (!name && !address) return null

  return (
    <div
      style={{
        marginTop: '7px',
        border: `1px solid ${toCustomer ? NAVY : RULE}`,
        background: TINT,
        padding: '7px 11px',
        display: 'flex',
        gap: '12px',
        alignItems: 'flex-start',
      }}
    >
      <div style={{ paddingTop: '1px', flexShrink: 0 }}>
        <Glyph name="truck" size={17} />
      </div>
      <Eyebrow style={{ flexShrink: 0, paddingTop: '3px' }}>Deliver To</Eyebrow>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: '12px', fontWeight: 800, textTransform: 'uppercase', color: NAVY }}>
          {name}
          {order.deliveryCustomer?.code && (
            <span style={{ fontWeight: 600, color: GREY, marginLeft: '7px', ...NUM }}>
              {order.deliveryCustomer.code}
            </span>
          )}
        </div>
        {address && (
          <div style={{ fontSize: '10.5px', color: GREY, lineHeight: 1.55, marginTop: '2px' }}>
            {address}
          </div>
        )}
        {toCustomer && (
          <div
            style={{
              fontSize: '9px',
              fontWeight: 700,
              letterSpacing: '.09em',
              textTransform: 'uppercase',
              marginTop: '3px',
            }}
          >
            Ship direct to this address — not to our works
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * The two rules this sheet needs from a stylesheet, and the only ones.
 *
 * Everything else on this page is an inline style on purpose — the app has a
 * dark theme, and a stylesheet that reached the printer would take it there.
 * These two cannot be done inline, because neither is a property of an
 * element:
 *
 * `@page` — without it Chrome applies its own ~10mm paper margin, and a block
 *   297mm tall inside a 277mm printable area spills onto a second sheet. That
 *   is what was happening: a one-line order came out of the printer on two
 *   pages, and the footer of the first still read "Page 1 of 1". The
 *   arithmetic at the top of this file was never wrong; there was simply
 *   nowhere for it to land. `PrintSheet` has this rule, but this page only
 *   borrows the toolbar from it, so it never arrived.
 *
 * `print-color-adjust` — Chrome drops background colours when printing unless
 *   told not to. This sheet is built from filled bands: the heading strips,
 *   the table head, the total and the footer. Left alone, every one of them
 *   would have printed white — white text on white paper for the total.
 *
 * The screen keeps the gap between sheets that tells you there are two of
 * them; the printer does not, because there the page break is the gap.
 */
const SHEET_CSS = `
@page { size: A4; margin: 0; }

/* The toolbar above the sheet.

   It comes from PrintToolbar, which marks itself .no-print and .print-toolbar
   — and both of those classes are defined inside PrintSheet, which this page
   does not render. So on this page the toolbar had no styling at all (it read
   as one run-on line) and, worse, nothing hid it from the printer. It was
   being printed at the top of the paper, pushing the sheet down, and that is
   what put every order on one more page than it said it was on: the sheet
   itself fitted all along.

   Declared here because this page borrows the component without the
   stylesheet that dresses it. */
.print-toolbar {
  display: flex;
  align-items: center;
  gap: 14px;
  max-width: 210mm;
  margin: 0 auto 12px;
  padding: 8px 12px;
  background: #fff;
  border-radius: 6px;
  font: 13px Inter, system-ui, sans-serif;
  color: #1f2b3d;
}
.print-toolbar .tb-hint { color: #5a6880; font-size: 12px; margin-right: auto; }
.print-toolbar .tb-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border: 1px solid #aebfd6;
  border-radius: 6px;
  background: #fff;
  color: #173a6c;
  font-size: 13px;
  font-weight: 600;
  text-decoration: none;
  cursor: pointer;
}
.print-toolbar .tb-primary { background: #173a6c; border-color: #173a6c; color: #fff; }

@media print {
  .no-print { display: none !important; }
  html, body { background: #fff !important; }
  /* 296, not 297. The sheet is 297mm and so is the paper, and a block exactly
     the height of the page box does not reliably fit inside it: the used
     height rounds up a fraction, the fraction does not fit, and the fraction
     becomes a second sheet with nothing on it. A millimetre absorbs that.
     A minimum, not a height, and no overflow clipping with it: if an order
     ever does run past the page it must break onto another one, badly, where
     somebody will see it, rather than be trimmed off where nobody will. */
  .po-sheet { margin: 0 !important; box-shadow: none !important; min-height: 296mm !important; }
  .po-sheet, .po-sheet * {
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
}
`

/** One A4 sheet. `break` puts a page break after it. */
function Sheet({
  children,
  breakAfter,
  footerLeft,
  footerRight,
}: {
  children: React.ReactNode
  breakAfter?: boolean
  footerLeft: string
  footerRight: string
}) {
  return (
    <div
      className="po-sheet"
      style={{
        width: '210mm',
        minHeight: '297mm',
        margin: '0 auto 10px',
        background: '#fff',
        boxSizing: 'border-box',
        fontFamily: SANS,
        color: INK,
        display: 'flex',
        flexDirection: 'column',
        pageBreakAfter: breakAfter ? 'always' : 'auto',
        breakAfter: breakAfter ? 'page' : 'auto',
      }}
    >
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {children}
      </div>

      {/* A filled band rather than a rule and some grey capitals. It is the
          last thing on a sheet that may be photocopied and filed, and the
          order number in it is what makes a loose page findable. */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '12px',
          margin: '6px 12mm 4mm',
          padding: '6px 11px',
          background: NAVY,
          color: '#fff',
          fontSize: '9px',
          fontWeight: 600,
          letterSpacing: '.07em',
          textTransform: 'uppercase',
          flexShrink: 0,
        }}
      >
        <span>{footerLeft}</span>
        <span style={{ opacity: 0.85 }}>{footerRight}</span>
      </div>
    </div>
  )
}

export default function PrintPurchaseOrder() {
  const { id } = useParams<{ id: string }>()
  const params = useSearchParams()
  const [data, setData] = useState<PrintPayload | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ success: boolean; data: PrintPayload }>(
        `/purchase/orders/${id}/print`
      )
      setData(res.data)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load this order.')
    }
  }, [id])

  useEffect(() => {
    void load()
  }, [load])

  if (error) {
    return (
      <div style={{ maxWidth: '210mm', margin: '40px auto', background: '#fff', padding: '24px' }}>
        <p style={{ color: '#a03030', margin: 0 }}>{error}</p>
      </div>
    )
  }

  if (!data) {
    return (
      <div style={{ maxWidth: '210mm', margin: '40px auto', color: '#fff', textAlign: 'center' }}>
        Loading...
      </div>
    )
  }

  const { company, template, taxMode } = data
  const order = data.order
  const supplier = order.supplier

  /**
   * `?lines=n` repeats the order's own lines until there are n of them, purely
   * to see the one-sheet / two-sheet switch without typing a long order.
   *
   * It is stamped across the sheet when used. A preview that could be mistaken
   * for the real order is worse than no preview: somebody would send it to a
   * supplier.
   */
  const sampleCount = Number(params.get('lines'))
  const sampleLines = Number.isFinite(sampleCount) && sampleCount >= 1 && sampleCount <= 60
  // `?to=customer` previews the direct-to-customer band on an order that goes
  // to one of our own godowns, which is every order on the system so far.
  const sampleCustomer = params.get('to') === 'customer'
  /*
   * `?charges=1` puts a couple of charge rows in the calculation.
   *
   * The charge master has six kinds set up and no order has ever carried one,
   * so the rows that name them — "Transport charges @(5%)" and the rest —
   * could otherwise only be looked at by raising a real order, entering an
   * amount and then deleting it, which costs a purchase order number for a
   * layout check. The tax figures are the real order's and do not move, which
   * is fine: the sheet is stamped DO NOT SEND whenever any of these flags are
   * on.
   */
  const sampleCharges = params.get('charges') === '1'
  const preview = sampleLines || sampleCustomer || sampleCharges
  const lines: Line[] =
    sampleLines && order.lines.length
      ? Array.from({ length: sampleCount }, (_, i) => {
          const src = order.lines[i % order.lines.length]
          return { ...src, id: `${src.id}-preview-${i}` }
        })
      : order.lines

  const companyAddress = [company.address, company.city, company.state, company.pincode]
    .filter(Boolean)
    .join(', ')
  /*
   * What the order was billed to, taken from the order itself.
   *
   * The supplier master is only the fallback, for orders raised before the
   * order started keeping this. A supplier moves, or bills a second order from
   * a different works — and reading the master at print time would reprint an
   * old order with an address it never carried.
   */
  const supplierAddress =
    order.supplierAddress ||
    [supplier.address, supplier.city, supplier.state, supplier.pincode].filter(Boolean).join(', ')

  /*
   * The order used for the blocks that most orders have nothing in yet.
   *
   * Every order on the system predates the enquiry fields and goes to one of
   * our own godowns, so without this the new rows and the new band can only be
   * looked at empty. Only ever built when a preview flag is set, and the sheet
   * is stamped DO NOT SEND whenever it is.
   */
  const sheetOrder: PrintPayload['order'] = preview
    ? {
        ...order,
        enquiryNo: order.enquiryNo ?? 'SQ/2026/0187',
        enquiryDate: order.enquiryDate ?? order.poDate,
        reference: order.reference ?? 'IND-4471',
        ...(sampleCharges
          ? {
              charges: [
                { amount: '150.00', gstRate: '5', chargeType: { name: 'Transport Charges' } },
                { amount: '80.00', gstRate: '18', chargeType: { name: 'Packing Charges' } },
                { amount: '0.00', gstRate: '0', chargeType: { name: 'Loading / Unloading' } },
              ],
            }
          : {}),
        ...(sampleCustomer
          ? {
              deliveryCustomer: { name: 'Shreeji Garments', code: 'CUST-0042', gstin: null },
              deliveryWarehouse: null,
              deliveryAddress:
                'Gala 7, Sai Industrial Estate, Dapoda Road, Bhiwandi, Thane, Maharashtra, 421302',
            }
          : {}),
      }
    : order

  const paymentTerms =
    supplier.paymentTerms || (supplier.creditDays ? `${supplier.creditDays} days` : null)

  /*
   * One row per charge this order carries, named and rated the way the mill's
   * old sheet names them — "Transport Charges @(5%)".
   *
   * Only the charges that were entered on the form. For a while this printed
   * a row for every charge in the master instead, so that one he wanted to
   * see would be there at 0.00 the way Other Charges is — but the master
   * holds five charges flagged for purchases, three of them near-duplicates,
   * and four rows of 0.00 on every sheet is four questions a supplier does
   * not need to ask. His instruction: show a charge only if it was added on
   * the order.
   *
   * Which means a charge he wants on the paper has to be typed into the
   * Totals panel on the form. That is the same rule as the old system's, and
   * the same rule as Other Charges except that Other Charges has a box of its
   * own and so always has an answer.
   */
  const chargeLines = (sheetOrder.charges ?? []).map((c) => ({
    label: `${c.chargeType.name} @(${Number(c.gstRate)}%)`,
    value: money(c.amount),
  }))

  /*
   * The split.
   *
   * What is left of the page once the chrome and the charge rows have taken
   * theirs, divided by the height of a line. See the note on the constants.
   *
   * It can reach nothing, and then every order splits: the lines on the first
   * sheet and the money overleaf. That is the honest answer for an order whose
   * calculation will not share a page with even one line, and getting it right
   * rather than printing "Page 1 of 1" on a two-page order is what the
   * arithmetic in this file is for.
   */
  const chargeRowCount = chargeLines.length
  const onOneSheet = Math.floor((A4_PX - SHEET_CHROME - CHARGE_ROW * chargeRowCount) / LINE_ROW)

  const splits = lines.length > onOneSheet
  const firstLines = splits ? lines.slice(0, ROWS_ON_FIRST_OF_TWO) : lines
  const restLines = splits ? lines.slice(ROWS_ON_FIRST_OF_TWO) : []
  const pageCount = splits ? 2 : 1

  const terms = order.terms || template.termsText
  const termLines = terms
    ? terms
        .split(/\r?\n/)
        .map((l) => l.replace(/^\s*\d+[.)]\s*/, '').trim())
        .filter(Boolean)
    : []
  /*
   * Where the terms break into two columns.
   *
   * Counted down the middle, four clauses go two and two — and the mill's
   * fourth clause is three times the length of its second, so the right
   * column ran half a sheet below the left. Split on the running length
   * instead: as many clauses go left as fill half the words, which is what
   * makes the two columns finish at about the same depth.
   */
  const half = (() => {
    const total = termLines.reduce((n, t) => n + t.length, 0)
    let run = 0
    for (let i = 0; i < termLines.length; i++) {
      run += termLines[i].length
      // Once this clause takes the left column past halfway, it is the last
      // one that belongs there.
      if (run >= total / 2) return i + 1
    }
    return termLines.length
  })()

  const footerLeft = `${company.name} — ${template.title} ${order.poNumber}`
  const stamp = (n: number) => `Page ${n} of ${pageCount}`

  /* ── Blocks, so the two sheets share them ───────────────────────────────── */

  const previewStamp = preview && (
    <div
      style={{
        margin: '0 12mm',
        marginTop: '6px',
        padding: '4px 8px',
        border: `1px solid ${AMBER}`,
        background: '#fffbeb',
        fontSize: '10px',
        fontWeight: 700,
        letterSpacing: '.1em',
        textTransform: 'uppercase',
        color: '#92400e',
        textAlign: 'center',
        flexShrink: 0,
      }}
    >
      Layout preview —{' '}
      {[
        sampleLines ? `${sampleCount} sample lines` : null,
        'a sample enquiry number',
        sampleCharges ? 'sample charges' : null,
        sampleCustomer ? 'a sample delivery customer' : null,
      ]
        .filter(Boolean)
        .join(', ')}
      . Not this order. Do not send.
    </div>
  )

  /*
   * Gathered into a list before being drawn.
   *
   * Half these rows are conditional — only the charges this order carries,
   * whichever tax split applies, rounding only when something rounded — and
   * the stripe has to alternate over the rows that actually print. Written as
   * JSX with the conditions inline, nothing could count them.
   *
   * Only the charges the order carries: printing every kind the mill uses, at
   * zero, would have the supplier hunting for which of five freight lines
   * applied to them.
   */
  const totalRows: { label: string; value: string }[] = [
    { label: 'Total Discount', value: money(order.discountAmount) },
    { label: 'Sub Total', value: money(order.taxableAmount) },

    /*
     * One row per charge the mill puts on a purchase, named and rated the way
     * the old sheet names them: "Transport Charges @(5%)".
     *
     * Every one of them, whether this order used it or not — at 0.00 when it
     * did not, exactly as Other Charges prints. He asked for that in those
     * words, and the reasoning is the same as for Other Charges: a row that
     * says 0.00 has been answered, where a row that is missing has only been
     * left out, and the supplier cannot tell which.
     *
     * A charge the order carries is shown even if its type has since been
     * deactivated or taken off purchases in the master. A document prints
     * what it holds; the master is only the source of the rows it does not.
     *
     * The rate is printed even when it is 0%. A charge that carries no GST is
     * a real thing, and saying so is more use than leaving it to be wondered
     * about.
     */
    ...chargeLines,

    ...(taxMode === 'CGST_SGST'
      ? [
          { label: 'SGST', value: money(order.sgst) },
          { label: 'CGST', value: money(order.cgst) },
        ]
      : []),
    ...(taxMode === 'IGST' ? [{ label: 'IGST', value: money(order.igst) }] : []),

    /*
     * Always printed, at 0.00 when there are none — as on the old sheet, and
     * because he named it as one of the rows he wants. It is also the one row
     * here that carries no GST of its own and is added after tax, so a reader
     * checking the arithmetic needs to see it even when it is nothing.
     */
    { label: 'Other Charges', value: money(order.otherCharges) },

    /*
     * Only when something actually rounded. The old sheet has no such row
     * because its figures happened to add up; ours takes the total to the
     * nearest rupee, and without this line the column above would not sum to
     * the total and every order would be queried.
     */
    ...(Number(order.roundOff) !== 0 ? [{ label: 'Rounding', value: money(order.roundOff) }] : []),
  ]

  const totalsBlock = (
    <div style={{ width: '46%', flexShrink: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ flex: 1 }}>
        {totalRows.map((r, i) => (
          <TotalRow key={`${r.label}-${i}`} label={r.label} value={r.value} alt={i % 2 === 0} />
        ))}
      </div>
      {/* The one figure the supplier will invoice against, so it is the
          heaviest mark on the sheet and the only one reversed out. */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '12px',
          background: NAVY,
          color: '#fff',
          padding: '9px 11px',
          flexShrink: 0,
        }}
      >
        <span
          style={{
            fontSize: '10px',
            fontWeight: 700,
            letterSpacing: '.1em',
            textTransform: 'uppercase',
          }}
        >
          Total
        </span>
        <span style={{ fontSize: '19px', fontWeight: 800, ...NUM }}>
          ₹ {money(order.totalAmount)}
        </span>
      </div>
    </div>
  )

  const closingBlock = (
    <>
      {/* One ruled box, split. The words and the figures are two readings
          of the same number, and side by side in a single frame they check
          each other — which is the whole reason a sheet carries the amount in
          words at all. */}
      <div
        style={{
          display: 'flex',
          marginTop: '9px',
          border: `1px solid ${RULE}`,
          alignItems: 'stretch',
        }}
      >
        <div
          style={{
            flex: 1,
            minWidth: 0,
            padding: '7px 11px',
            borderRight: `1px solid ${RULE}`,
          }}
        >
          {template.showAmountInWords && (
            <>
              <Eyebrow>Amount in words</Eyebrow>
              <div
                style={{
                  fontSize: '13px',
                  fontWeight: 700,
                  lineHeight: 1.45,
                  marginTop: '3px',
                  color: NAVY,
                }}
              >
                {data.totalInWords}
              </div>
            </>
          )}

          <Eyebrow style={{ marginTop: '10px' }}>Special notes</Eyebrow>
          <div
            style={{
              fontSize: '11px',
              lineHeight: 1.6,
              marginTop: '3px',
              whiteSpace: 'pre-wrap',
            }}
          >
            {order.notes || <Dash />}
          </div>

          {taxMode === 'NONE' && (
            <div style={{ fontSize: '10.5px', color: GREY, marginTop: '8px' }}>
              Supplier is not registered under GST, so this order carries no tax.
            </div>
          )}
        </div>
        {totalsBlock}
      </div>

      {termLines.length > 0 && (
        <Panel
          title="Terms & Conditions"
          style={{ marginTop: '8px' }}
          bodyStyle={{ padding: '4px 11px' }}
        >
          <div style={{ display: 'flex', gap: '22px' }}>
            {[termLines.slice(0, half), termLines.slice(half)].map((part, col) =>
              part.length ? (
                /*
                 * The number is drawn, not left to the list.
                 *
                 * This page renders inside the app, and the app's CSS reset
                 * takes the markers off every `ol` in the project. So the
                 * terms printed as four unnumbered paragraphs — and a term
                 * a supplier cannot cite by number is a term that gets
                 * argued about. A flex row per item puts the figure back
                 * where the marker was, hanging, with the text aligned
                 * under itself on the wrap.
                 */
                <div key={col} style={{ flex: 1, minWidth: 0 }}>
                  {part.map((t, i) => (
                    <div
                      key={i}
                      style={{
                        display: 'flex',
                        gap: '7px',
                        fontSize: '10px',
                        lineHeight: 1.7,
                        color: GREY,
                        marginBottom: '3px',
                      }}
                    >
                      <span
                        style={{
                          width: '15px',
                          flexShrink: 0,
                          textAlign: 'right',
                          fontWeight: 600,
                          color: NAVY,
                          ...NUM,
                        }}
                      >
                        {(col === 0 ? 0 : half) + i + 1}.
                      </span>
                      <span style={{ minWidth: 0 }}>{t}</span>
                    </div>
                  ))}
                </div>
              ) : null
            )}
          </div>
        </Panel>
      )}

      {template.declaration && (
        <div style={{ fontSize: '10px', color: GREY, marginTop: '8px' }}>
          {template.declaration}
        </div>
      )}

      {template.showSignature && (
        <div style={{ display: 'flex', gap: '26px', marginTop: 'auto', paddingTop: '5px' }}>
          {['Authorized Signature', 'Director'].map((role, i) => (
            <div key={role} style={{ flex: 1 }}>
              {/* The signature sits on a tinted panel the width of the image
                  rather than floating over the paper, so a scanned signature
                  with a white background does not read as a smudge above the
                  rule. The Director's space is left empty and the same height,
                  because the two rules have to line up across the sheet. */}
              {i === 0 && company.signatureUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={company.signatureUrl}
                  alt=""
                  style={{
                    height: '30px',
                    width: 'auto',
                    objectFit: 'contain',
                    display: 'block',
                    background: TINT,
                    border: `1px solid ${RULE_SOFT}`,
                    padding: '2px 8px',
                    boxSizing: 'content-box',
                  }}
                />
              ) : (
                <div style={{ height: '36px' }} />
              )}
              <div
                style={{ borderTop: `1.5px solid ${NAVY}`, paddingTop: '4px', marginTop: '3px' }}
              >
                <div style={{ fontSize: '11px', fontWeight: 700, color: NAVY }}>{role}</div>
                <div style={{ fontSize: '10px', color: GREY, marginTop: '1px' }}>
                  For {company.name}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  )

  return (
    <>
      <PrintToolbar
        backHref="/purchase/orders"
        backLabel="Back to orders"
        copies={template.copies.length || 1}
        fileName={order.poNumber}
      />

      <style>{SHEET_CSS}</style>

      {/* No `overflow-x-auto` here.

          It was added so a phone could pan the 210mm sheet instead of the
          whole document sliding sideways, and it cost a page: a scroll
          container's content cannot be broken across printed pages, so the
          sheets inside it stopped paginating and every order came out on one
          more page than it said. The sideways pan on a phone is worth less
          than a printed page count that is true. */}
      <div className="print-surface">
        {/* ── Sheet one ─────────────────────────────────────────────────── */}
        <Sheet breakAfter={splits} footerLeft={footerLeft} footerRight={stamp(1)}>
          {previewStamp}

          <div
            style={{
              padding: '6mm 12mm 0',
              flex: 1,
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            {/* Letterhead */}
            <div style={{ display: 'flex', gap: '16px', alignItems: 'flex-start' }}>
              {/* The mark was in Settings all along and the sheet never
                  printed it. A supplier sorting the day's post knows the mill
                  by it before reading a word, which is most of what a
                  letterhead is for. Height is capped rather than width: the
                  logo is whatever shape it was uploaded as, and a fixed width
                  would squash a wide one. */}
              {company.logoUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={company.logoUrl}
                  alt=""
                  style={{
                    height: '52px',
                    width: 'auto',
                    maxWidth: '124px',
                    objectFit: 'contain',
                    flexShrink: 0,
                  }}
                />
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: '26px',
                    fontWeight: 800,
                    letterSpacing: '-.01em',
                    textTransform: 'uppercase',
                    lineHeight: 1.05,
                    color: NAVY,
                  }}
                >
                  {company.name}
                </div>
                {companyAddress && (
                  <div
                    style={{
                      fontSize: '10.5px',
                      color: GREY,
                      lineHeight: 1.6,
                      marginTop: '4px',
                      maxWidth: '86%',
                    }}
                  >
                    {companyAddress}
                  </div>
                )}
              </div>
              <div style={{ flexShrink: 0 }}>
                <HeadRow icon="mail" label="Email" value={company.email} />
                <HeadRow icon="phone" label="Phone No" value={company.phone} mono />
                <HeadRow icon="gst" label="GST No" value={company.gstin} mono />
                <HeadRow icon="pan" label="PAN No" value={company.pan} mono />
                {/* On the old sheet, so it is on this one. There is no TIN on
                    the company record and there will not be one worth filling:
                    a TIN is the pre-GST state registration and has not been
                    issued since 2017, which is why it is blank on the mill's
                    own old paper too. Here so the letterhead reads the same;
                    one line to delete if he would rather it went. */}
                <HeadRow icon="gst" label="TIN No" value={null} mono />
                <HeadRow icon="web" label="Website" value={company.website} />
              </div>
            </div>

            <div style={{ borderTop: `2.5px solid ${NAVY}`, marginTop: '7px' }} />

            {/* Title and number */}
            <div
              style={{
                display: 'flex',
                alignItems: 'flex-end',
                justifyContent: 'space-between',
                gap: '16px',
                padding: '5px 0 7px',
              }}
            >
              <div>
                <Eyebrow style={{ color: GREY }}>Document</Eyebrow>
                <div
                  style={{
                    fontSize: '27px',
                    fontWeight: 800,
                    textTransform: 'uppercase',
                    letterSpacing: '-.015em',
                    marginTop: '1px',
                    color: NAVY,
                    lineHeight: 1.1,
                  }}
                >
                  {template.title}
                </div>
              </div>
              {/* The number and the date have moved down into the block
                  below, beside the supplier, which is where the mill's old
                  sheet puts them. */}
            </div>

            {/* Who the order is to, and which order it is.

              Set out as the mill's old sheet sets it out: "To," over the
              supplier, the address and the registration numbers running on
              under it, and the order number and date in their own column
              beside them. He asked for this section as it stands on that
              sheet, and called it the professional one.

              What went with the change: the ORDER DETAILS panel, which held
              the order type, the line count, the total quantity and the
              currency. None of those are on the old sheet. The two from that
              panel that are worth printing — the supplier's own quotation
              number and our reference — moved into the column on the right,
              and only appear when the order actually carries them.

              Payment Terms is the one line here that the old sheet does not
              have. It is kept because it is the sentence that tells a
              supplier what they are being held to; without it they are left
              to assume. One line to delete if he would rather it matched
              exactly. */}
            <div
              style={{
                border: `1px solid ${RULE}`,
                display: 'flex',
                gap: '20px',
                padding: '9px 11px',
                alignItems: 'flex-start',
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '11px', fontWeight: 700, color: NAVY }}>To,</div>
                <div
                  style={{
                    fontSize: '14px',
                    fontWeight: 800,
                    textTransform: 'uppercase',
                    color: NAVY,
                    marginTop: '1px',
                    lineHeight: 1.25,
                  }}
                >
                  {supplier.name}
                </div>
                <ToLine label="Address-" value={supplierAddress || null} />
                <ToLine label="GST No" value={supplier.gstin} mono />
                <ToLine label="Contact No" value={supplier.phone} mono />
                {/* Nothing fills this yet — there is no contact-person field
                    on a supplier — and it is blank on the old sheet for the
                    same reason. Printed because a supplier used to reading
                    that sheet looks for it. */}
                <ToLine label="Kind Attention" value={null} />
                <ToLine label="Payment Terms" value={paymentTerms} />
              </div>

              <div style={{ flexShrink: 0 }}>
                <PoLine label="P.O No" value={order.poNumber} mono />
                <PoLine label="P.O Date" value={shortDate(order.poDate)} mono />
                {/* Their quotation number before our own reference: it is the
                    supplier's way in, and this is the supplier's copy. Shown
                    only when the order carries one, so a sheet for an ordinary
                    order reads exactly like the old one. */}
                {sheetOrder.enquiryNo && (
                  <PoLine label="Enquiry No" value={sheetOrder.enquiryNo} mono />
                )}
                {sheetOrder.enquiryDate && (
                  <PoLine label="Enquiry Date" value={shortDate(sheetOrder.enquiryDate)} mono />
                )}
                {sheetOrder.reference && (
                  <PoLine label="Your reference" value={sheetOrder.reference} />
                )}
              </div>
            </div>

            <DeliverToBand
              order={sheetOrder}
              companyName={company.name}
              companyAddress={companyAddress}
            />

            {/* Lines */}
            <div style={{ marginTop: '9px' }}>
              <LineTable lines={firstLines} startIndex={0} />
            </div>

            {splits ? (
              <div
                style={{
                  marginTop: '8px',
                  padding: '6px 11px',
                  background: TINT,
                  border: `1px solid ${RULE}`,
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: '12px',
                  fontSize: '9.5px',
                  fontWeight: 600,
                  letterSpacing: '.08em',
                  textTransform: 'uppercase',
                  color: NAVY,
                }}
              >
                <span>
                  {restLines.length > 0
                    ? `Lines 1–${firstLines.length} of ${lines.length} — continued on page 2`
                    : `All ${lines.length} lines shown — nothing continues overleaf`}
                </span>
                <span style={{ color: MUTED }}>Totals and terms overleaf</span>
              </div>
            ) : (
              closingBlock
            )}
          </div>
        </Sheet>

        {/* ── Sheet two, only when it is needed ─────────────────────────── */}
        {splits && (
          <Sheet footerLeft={footerLeft} footerRight={stamp(2)}>
            {previewStamp}

            <div
              style={{
                padding: '10mm 12mm 0',
                flex: 1,
                minHeight: 0,
                display: 'flex',
                flexDirection: 'column',
              }}
            >
              {/* The band that makes a loose second sheet identifiable. */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  justifyContent: 'space-between',
                  gap: '14px',
                  paddingBottom: '8px',
                  borderBottom: `2.5px solid ${NAVY}`,
                }}
              >
                <div
                  style={{
                    fontSize: '17px',
                    fontWeight: 800,
                    textTransform: 'uppercase',
                    letterSpacing: '-.01em',
                    color: NAVY,
                  }}
                >
                  {company.name}
                </div>
                <div style={{ display: 'flex', gap: '16px', fontSize: '10.5px', color: GREY }}>
                  <span>
                    {template.title}{' '}
                    <strong style={{ color: INK, ...CODE }}>{order.poNumber}</strong>
                  </span>
                  <span>
                    Date <strong style={{ color: INK, ...NUM }}>{shortDate(order.poDate)}</strong>
                  </span>
                  <span>
                    Supplier <strong style={{ color: INK }}>{supplier.name}</strong>
                  </span>
                </div>
              </div>

              {/* When the lines all fitted on page 1 and only the totals
                  came over, there is nothing to tabulate — and a column
                  header with no rows beneath it reads as lost data. */}
              {restLines.length > 0 && (
                <div style={{ marginTop: '11px' }}>
                  <LineTable lines={restLines} startIndex={firstLines.length} />
                </div>
              )}

              {closingBlock}
            </div>
          </Sheet>
        )}
      </div>
    </>
  )
}
