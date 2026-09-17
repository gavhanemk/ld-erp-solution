'use client'

import { useCallback, useEffect, useState } from 'react'
import { useParams, useSearchParams } from 'next/navigation'
import { api, ApiError } from '@/lib/api'
import { PrintToolbar, money } from '@/components/print/PrintSheet'

/**
 * The printed purchase order.
 *
 * ── Pagination is ours, not the browser's ───────────────────────────────────
 *
 * The lines are split into sheets here and each sheet is its own block with a
 * page break after it. That costs a little arithmetic and buys the two things
 * a browser cannot give you: a real "Page 1 of 2", and a header band repeated
 * at the top of the second sheet naming the order it belongs to. Left to the
 * browser, a twenty-six line order spills onto a second page that carries no
 * clue which order it is — and a loose sheet on a mill floor with no order
 * number on it is a sheet nobody can act on.
 *
 * The rule, which is about what fits rather than what looks tidy:
 *
 *   15 lines or fewer  →  one sheet. Table, totals, terms and signatures all
 *                         fit beneath each other.
 *   more than 15       →  two sheets. The totals block and everything under
 *                         it will not fit, so it moves to the second sheet —
 *                         which frees the first to carry 19 lines instead of
 *                         15, and the first sheet says it continues.
 *
 * ── The rules this sheet is held to ─────────────────────────────────────────
 *
 * - **Inter, and nothing else.** The one exception is the monospace stack for
 *   codes, quantities, rates and GSTINs: `font-mono` is defined in this
 *   project for figures that must line up down a column, which is exactly
 *   what they do here. Numbers also carry `tabular-nums` so the digits sit in
 *   their columns rather than wandering.
 * - **Inline styles only.** The paper must not depend on the app stylesheet,
 *   and the app has a dark theme that would otherwise reach the printer.
 * - **Percentage column widths, never pixels.** Fixed pixels are what once
 *   made this table cover half the sheet.
 * - **Black on white.** The only colour is the accent bar, and it uses our own
 *   three brand colours rather than the reference's red/yellow/blue — blue is
 *   not a colour this system has.
 */

interface Line {
  id: string
  description: string | null
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

/**
 * How many lines fit. See the note at the top for why there are two numbers.
 *
 * Set against the current type size and kept deliberately short: a row is
 * about 40px once its padding and an optional second line are counted, and a
 * sheet has roughly 1050px to give after the letterhead, the panels and the
 * footer have taken theirs. Erring low costs a little white space at the foot
 * of a page; erring high used to cost a line off the end of the order.
 *
 * These two are the numbers to nudge if the break falls in the wrong place.
 */
/*
 * Both came down by three when the sheet started carrying the delivery
 * destination and the enquiry. The band is about 58px and the order panel
 * gained two rows, call it 100px, and a row is about 40px — so two and a half
 * rows' worth of room went, and three is the safe side of that.
 *
 * Erring low costs white space at the foot of a page. Erring high no longer
 * cuts lines off (the sheet is a minimum height now, not a fixed one) but the
 * browser inserts its own break instead, and then "Page 1 of 2" is a lie.
 */
const FITS_ON_ONE_SHEET = 9
const ROWS_ON_FIRST_OF_TWO = 13

const BLACK = '#000000'
const INK = '#111111'
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
const GREY = '#2b2b2b'
// Still quieter than a real value, but no longer a smudge.
const MUTED = '#595959'
// The rules came up with the text, because they are the other half of why a
// sheet reads badly on paper. #d8d8d8 is 1.4:1 — on a screen it is a tidy
// hairline, and out of a mill's laser printer it is a dotted suggestion of a
// line. The table has to hold its columns together after a photocopy.
const RULE = '#b8b8b8'
const RULE_SOFT = '#d0d0d0'
const PANEL = '#fafafa'
const TEAL = '#14b8a6'
const AMBER = '#f59e0b'
const NAVY = '#1e293b'

const SANS = 'Inter, system-ui, sans-serif'
const MONO = '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace'

/**
 * "Packaging > Tapes" from whichever level the item was filed under.
 *
 * An item can sit on a parent category directly, in which case there is no
 * subcategory and the one name is the whole answer.
 */
function categoryPath(c?: { name: string; parent?: { name: string } | null } | null): string | null {
  if (!c) return null
  return c.parent ? `${c.parent.name} › ${c.name}` : c.name
}

/**
 * The order type in words.
 *
 * `poType` holds a code the buyer picks on the form, and a code is not
 * something to put in front of a supplier — the sheet used to print
 * "STANDARD" and would otherwise now print "ITEM_LEVEL". Item-level discount
 * is the ordinary way the mill orders, so it keeps reading "Standard" and the
 * printed sheet does not change for the vast majority of orders.
 */
const ORDER_TYPES: Record<string, string> = {
  ITEM_LEVEL: 'Standard',
  STANDARD: 'Standard',
  ORDER_LEVEL: 'Discount on the order',
  NONE: 'No discount',
}

/** Every figure on the sheet goes through here, so columns align. */
const NUM: React.CSSProperties = { fontFamily: MONO, fontVariantNumeric: 'tabular-nums' }

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
        fontSize: '9px',
        fontWeight: 700,
        letterSpacing: '.18em',
        textTransform: 'uppercase',
        color: GREY,
        ...style,
      }}
    >
      {children}
    </div>
  )
}

function HeadRow({ label, value, mono }: { label: string; value: string | null; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', lineHeight: 1.65 }}>
      <span style={{ fontSize: '9.5px', color: GREY, minWidth: '64px', textAlign: 'right' }}>
        {label}
      </span>
      <span
        style={{
          fontSize: '10.5px',
          fontWeight: 600,
          minWidth: '168px',
          ...(mono && value ? NUM : {}),
        }}
      >
        {value || <Dash />}
      </span>
    </div>
  )
}

function DetailRow({
  label,
  value,
  mono,
  last,
}: {
  label: string
  value: string | null
  mono?: boolean
  last?: boolean
}) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'baseline',
        gap: '10px',
        padding: '7px 0',
        borderBottom: last ? 'none' : `1px solid ${RULE_SOFT}`,
      }}
    >
      <span style={{ fontSize: '10.5px', color: GREY }}>{label}</span>
      <span
        style={{
          fontSize: '11px',
          fontWeight: 700,
          textAlign: 'right',
          ...(mono && value ? NUM : {}),
        }}
      >
        {value || <Dash />}
      </span>
    </div>
  )
}

function TotalRow({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        gap: '12px',
        padding: '6px 12px',
        fontSize: '11px',
        color: GREY,
      }}
    >
      <span>{label}</span>
      <span style={{ color: INK, ...NUM }}>{value}</span>
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
const COLS = [
  { w: '5%', label: 'S.N', align: 'center' as const },
  { w: '32%', label: 'Description', align: 'left' as const },
  // 15% is about 14 mono characters. The longest code in the item master is
  // 12, so there is room for the master to grow before this wraps again.
  { w: '15%', label: 'Code', align: 'left' as const },
  { w: '8%', label: 'HSN', align: 'left' as const },
  { w: '9%', label: 'Qty', align: 'right' as const },
  { w: '6%', label: 'UOM', align: 'center' as const },
  { w: '8%', label: 'Rate', align: 'right' as const },
  { w: '6%', label: 'Disc.', align: 'right' as const },
  { w: '11%', label: 'Amount', align: 'right' as const },
]

function LineTable({ lines, startIndex }: { lines: Line[]; startIndex: number }) {
  const th: React.CSSProperties = {
    padding: '7.5px 7px',
    fontSize: '9px',
    fontWeight: 700,
    letterSpacing: '.1em',
    textTransform: 'uppercase',
    color: GREY,
    borderBottom: `1.5px solid ${BLACK}`,
    borderTop: `1px solid ${RULE}`,
    whiteSpace: 'nowrap',
  }

  const td: React.CSSProperties = {
    padding: '8.5px 7px',
    fontSize: '11px',
    color: INK,
    borderBottom: `1px solid ${RULE_SOFT}`,
    verticalAlign: 'top',
  }

  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
      <colgroup>
        {COLS.map((c, i) => (
          <col key={i} style={{ width: c.w }} />
        ))}
      </colgroup>
      <thead>
        <tr>
          {COLS.map((c, i) => (
            <th key={i} style={{ ...th, textAlign: c.align }}>
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
              <div style={{ fontWeight: 700 }}>{line.item.name}</div>
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
                      fontSize: '9px',
                      letterSpacing: '.06em',
                      textTransform: 'uppercase',
                      color: GREY,
                      marginTop: '1.5px',
                    }}
                  >
                    {parts.join('  ·  ')}
                  </div>
                )
              })()}
            </td>
            {/* Deliberately allowed to wrap. The column is wide enough for
                every code we have, and a longer one in future should take a
                second line rather than run into the HSN beside it.
                `break-word`, not `anywhere` — PROJECT_STATUS records a printed
                supplier address that came out one letter per line because
                `anywhere` lets a column collapse to a single character. */}
            <td style={{ ...td, ...NUM, fontSize: '10.5px', overflowWrap: 'break-word' }}>
              {line.item.code}
            </td>
            <td style={{ ...td, ...NUM, fontSize: '10.5px', color: GREY }}>
              {line.hsnCode || <Dash />}
            </td>
            <td style={{ ...td, ...NUM, textAlign: 'right', fontWeight: 700 }}>
              {money(line.qty)}
            </td>
            <td style={{ ...td, textAlign: 'center', color: GREY }}>
              {line.item.uom?.symbol || <Dash />}
            </td>
            <td style={{ ...td, ...NUM, textAlign: 'right' }}>{money(line.unitRate)}</td>
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
            <td style={{ ...td, ...NUM, textAlign: 'right', fontWeight: 700 }}>
              {money(line.amount)}
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
    order.deliveryAddress || order.deliveryWarehouse?.address || (toCustomer ? null : companyAddress)

  if (!name && !address) return null

  return (
    <div
      style={{
        marginTop: '9px',
        border: `1px solid ${toCustomer ? BLACK : RULE}`,
        borderRadius: '5px',
        padding: '9px 11px',
        display: 'flex',
        gap: '14px',
        alignItems: 'baseline',
      }}
    >
      <Eyebrow style={{ flexShrink: 0 }}>Deliver To</Eyebrow>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: '12px', fontWeight: 800, textTransform: 'uppercase' }}>
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

      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          gap: '12px',
          margin: '0 12mm',
          padding: '7px 0 8mm',
          borderTop: `1px solid ${RULE}`,
          fontSize: '9px',
          letterSpacing: '.14em',
          textTransform: 'uppercase',
          color: MUTED,
          flexShrink: 0,
        }}
      >
        <span>{footerLeft}</span>
        <span>{footerRight}</span>
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
        `/purchase/orders/${id}/print`,
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
  const preview = sampleLines || sampleCustomer
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

  // Counted off the lines being printed, so the summary can never disagree
  // with the table underneath it.
  const totalQty = lines.reduce((sum, l) => sum + Number(l.qty), 0)
  const uoms = Array.from(new Set(lines.map((l) => l.item.uom?.symbol).filter(Boolean)))
  const totalQtyLabel =
    uoms.length === 1 ? `${money(totalQty)} ${uoms[0]}` : `${money(totalQty)} (mixed units)`

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

  // The split.
  const splits = lines.length > FITS_ON_ONE_SHEET
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
  const half = Math.ceil(termLines.length / 2)

  const footerLeft = `${company.name} — ${template.title} ${order.poNumber}`
  const stamp = (n: number) => `Page ${n} of ${pageCount}`

  /* ── Blocks, so the two sheets share them ───────────────────────────────── */

  const accentBar = (
    <div style={{ display: 'flex', height: '5px', flexShrink: 0 }}>
      <div style={{ flex: 1, background: TEAL }} />
      <div style={{ flex: 1, background: AMBER }} />
      <div style={{ flex: 1, background: NAVY }} />
      <div style={{ flex: 1, background: BLACK }} />
    </div>
  )

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
        sampleCustomer ? 'a sample delivery customer' : null,
      ]
        .filter(Boolean)
        .join(', ')}
      . Not this order. Do not send.
    </div>
  )

  const totalsBlock = (
    <div style={{ width: '46%', flexShrink: 0 }}>
      <div style={{ background: PANEL, border: `1px solid ${RULE}`, padding: '5px 0' }}>
        <TotalRow label="Total Discount" value={money(order.discountAmount)} />
        <TotalRow label="Sub Total" value={money(order.taxableAmount)} />
        {/* Only the charges this order actually carries. Printing every kind
            the mill uses, at zero, would have the supplier hunting for which
            of five freight lines applied to them. */}
        {(order.charges ?? [])
          .filter((c) => Number(c.amount) !== 0)
          .map((c, i) => (
            <TotalRow
              key={`${c.chargeType.name}-${i}`}
              label={`${c.chargeType.name} @${Number(c.gstRate)}%`}
              value={money(c.amount)}
            />
          ))}
        {taxMode === 'CGST_SGST' && (
          <>
            <TotalRow label="SGST" value={money(order.sgst)} />
            <TotalRow label="CGST" value={money(order.cgst)} />
          </>
        )}
        {taxMode === 'IGST' && <TotalRow label="IGST" value={money(order.igst)} />}
        {Number(order.otherCharges) !== 0 && (
          <TotalRow label="Other Charges" value={money(order.otherCharges)} />
        )}
        {Number(order.roundOff) !== 0 && (
          <TotalRow label="Rounding" value={money(order.roundOff)} />
        )}
      </div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '12px',
          background: BLACK,
          color: '#fff',
          padding: '10px 11px',
        }}
      >
        <span
          style={{
            fontSize: '9.5px',
            fontWeight: 700,
            letterSpacing: '.18em',
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
      <div style={{ display: 'flex', gap: '16px', marginTop: '12px' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {template.showAmountInWords && (
            <>
              <Eyebrow>Amount in words</Eyebrow>
              <div style={{ fontSize: '12.5px', lineHeight: 1.5, marginTop: '3px' }}>
                {data.totalInWords}
              </div>
            </>
          )}

          <Eyebrow style={{ marginTop: '12px' }}>Special notes</Eyebrow>
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
        <div style={{ marginTop: '14px', borderTop: `1px solid ${RULE}`, paddingTop: '9px' }}>
          <Eyebrow>Terms &amp; Conditions</Eyebrow>
          <div style={{ display: 'flex', gap: '20px', marginTop: '5px' }}>
            {[termLines.slice(0, half), termLines.slice(half)].map((part, col) =>
              part.length ? (
                <ol
                  key={col}
                  start={col === 0 ? 1 : half + 1}
                  style={{
                    flex: 1,
                    margin: 0,
                    paddingLeft: '15px',
                    fontSize: '10px',
                    lineHeight: 1.6,
                    color: GREY,
                  }}
                >
                  {part.map((t, i) => (
                    <li key={i} style={{ marginBottom: '2px' }}>
                      {t}
                    </li>
                  ))}
                </ol>
              ) : null,
            )}
          </div>
        </div>
      )}

      {template.declaration && (
        <div style={{ fontSize: '10px', color: GREY, marginTop: '8px' }}>{template.declaration}</div>
      )}

      {template.showSignature && (
        <div style={{ display: 'flex', gap: '24px', marginTop: 'auto', paddingTop: '22px' }}>
          {['Authorized Signature', 'Director'].map((role, i) => (
            <div key={role} style={{ flex: 1 }}>
              {i === 0 && company.signatureUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={company.signatureUrl}
                  alt=""
                  style={{ height: '32px', objectFit: 'contain', display: 'block' }}
                />
              ) : (
                <div style={{ height: '32px' }} />
              )}
              <div style={{ borderTop: `1.5px solid ${BLACK}`, paddingTop: '4px' }}>
                <div style={{ fontSize: '11px', fontWeight: 700 }}>{role}</div>
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
      />

      <div className="print-surface">
        {/* ── Sheet one ─────────────────────────────────────────────────── */}
        <Sheet breakAfter={splits} footerLeft={footerLeft} footerRight={stamp(1)}>
          {accentBar}
          {previewStamp}

          <div
            style={{
              padding: '8mm 12mm 0',
              flex: 1,
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            {/* Letterhead */}
            <div style={{ display: 'flex', gap: '16px', alignItems: 'flex-start' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: '26px',
                    fontWeight: 800,
                    letterSpacing: '-.01em',
                    textTransform: 'uppercase',
                    lineHeight: 1.05,
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
                      marginTop: '5px',
                      maxWidth: '76%',
                    }}
                  >
                    {companyAddress}
                  </div>
                )}
              </div>
              <div style={{ flexShrink: 0 }}>
                <HeadRow label="Email" value={company.email} />
                <HeadRow label="Phone No" value={company.phone} mono />
                <HeadRow label="GST No" value={company.gstin} mono />
                <HeadRow label="PAN No" value={company.pan} mono />
                <HeadRow label="Website" value={company.website} />
              </div>
            </div>

            <div style={{ borderTop: `2.5px solid ${BLACK}`, marginTop: '9px' }} />

            {/* Title and number */}
            <div
              style={{
                display: 'flex',
                alignItems: 'flex-end',
                justifyContent: 'space-between',
                gap: '16px',
                padding: '9px 0 12px',
              }}
            >
              <div>
                <Eyebrow style={{ color: TEAL }}>Document</Eyebrow>
                <div
                  style={{
                    fontSize: '23px',
                    fontWeight: 800,
                    textTransform: 'uppercase',
                    letterSpacing: '-.01em',
                    marginTop: '1px',
                  }}
                >
                  {template.title}
                </div>
              </div>
              <div style={{ display: 'flex', textAlign: 'right' }}>
                <div style={{ padding: '0 15px' }}>
                  <Eyebrow>P.O No</Eyebrow>
                  <div style={{ fontSize: '16px', fontWeight: 800, marginTop: '2px', ...NUM }}>
                    {order.poNumber}
                  </div>
                </div>
                <div style={{ padding: '0 0 0 15px', borderLeft: `1px solid ${RULE}` }}>
                  <Eyebrow>P.O Date</Eyebrow>
                  <div style={{ fontSize: '16px', fontWeight: 800, marginTop: '2px', ...NUM }}>
                    {shortDate(order.poDate)}
                  </div>
                </div>
              </div>
            </div>

            {/* Supplier and order details */}
            <div style={{ display: 'flex', gap: '9px' }}>
              <div
                style={{
                  width: '58%',
                  border: `1px solid ${RULE}`,
                  borderRadius: '5px',
                  padding: '11px',
                }}
              >
                <Eyebrow>Supplier</Eyebrow>
                <div
                  style={{
                    fontSize: '15px',
                    fontWeight: 800,
                    textTransform: 'uppercase',
                    marginTop: '4px',
                  }}
                >
                  {supplier.name}
                </div>
                {supplierAddress && (
                  <div style={{ fontSize: '10.5px', color: GREY, lineHeight: 1.6, marginTop: '4px' }}>
                    {supplierAddress}
                  </div>
                )}
                <div style={{ borderTop: `1px solid ${RULE}`, margin: '8px 0 4px' }} />
                <DetailRow label="GST No" value={supplier.gstin} mono />
                <DetailRow label="Contact No" value={supplier.phone} mono />
                {/* Kind Attention was in the design we were handed and there is
                    no such field on an order, so it printed a dash forever. */}
                <DetailRow label="Payment Terms" value={paymentTerms} last />
              </div>

              <div
                style={{
                  width: '42%',
                  border: `1px solid ${RULE}`,
                  borderRadius: '5px',
                  padding: '11px',
                }}
              >
                <Eyebrow>Order Details</Eyebrow>
                <div style={{ marginTop: '4px' }}>
                  <DetailRow
                    label="Order type"
                    value={order.poType ? (ORDER_TYPES[order.poType] ?? order.poType) : null}
                  />
                  {/* Their quotation number goes above our own reference: it is
                      the supplier's way in, and this is the supplier's copy. */}
                  <DetailRow label="Enquiry No" value={sheetOrder.enquiryNo} mono />
                  <DetailRow
                    label="Enquiry Date"
                    value={sheetOrder.enquiryDate ? shortDate(sheetOrder.enquiryDate) : null}
                    mono
                  />
                  <DetailRow label="Your reference" value={sheetOrder.reference} />
                  <DetailRow label="Line items" value={String(lines.length)} mono />
                  <DetailRow label="Total qty" value={totalQtyLabel} mono />
                  <DetailRow label="Currency" value="INR (₹)" last />
                </div>
              </div>
            </div>

            <DeliverToBand
              order={sheetOrder}
              companyName={company.name}
              companyAddress={companyAddress}
            />

            {/* Lines */}
            <div style={{ marginTop: '12px' }}>
              <LineTable lines={firstLines} startIndex={0} />
            </div>

            {splits ? (
              <div
                style={{
                  marginTop: '8px',
                  paddingTop: '7px',
                  borderTop: `1px solid ${RULE}`,
                  display: 'flex',
                  justifyContent: 'space-between',
                  fontSize: '10px',
                  letterSpacing: '.1em',
                  textTransform: 'uppercase',
                  color: GREY,
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
                  borderBottom: `2.5px solid ${BLACK}`,
                }}
              >
                <div
                  style={{
                    fontSize: '17px',
                    fontWeight: 800,
                    textTransform: 'uppercase',
                    letterSpacing: '-.01em',
                  }}
                >
                  {company.name}
                </div>
                <div style={{ display: 'flex', gap: '16px', fontSize: '10.5px', color: GREY }}>
                  <span>
                    {template.title}{' '}
                    <strong style={{ color: INK, ...NUM }}>{order.poNumber}</strong>
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
