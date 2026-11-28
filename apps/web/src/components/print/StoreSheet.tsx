'use client'

import {
  Band,
  Box,
  CODE,
  Dash,
  DocTable,
  DocumentSheet,
  Eyebrow,
  Fact,
  INK,
  Note,
  NUM,
  PartyBlock,
  PartyLine,
  Signatures,
  TaxByRate,
  Terms,
  TotalsBox,
  WordsAndTotals,
  longDate,
  money,
  qty,
  shortDate,
  type DocColumn,
  type GlyphName,
  type TotalLine,
} from '@/components/print/doc'

/**
 * The store's and the sales desk's printed papers — issue slip, transfer
 * note, count sheet, sales order, invoice, challan and the rest.
 *
 * Every one of them is drawn by the shared document kit (components/print/doc)
 * in black and white, with only the logo in colour. Since 27 Nov 2026 they are
 * laid out like the purchase order too: "DOCUMENT" and the title, then the
 * "To," block — the party on the left, the document's number, date and
 * references on the right — then "Deliver to" bands, the lines with no blank
 * filler rows, the amount in words beside the totals, GST by rate, terms and
 * signatures. A page passes `party` (and `bands`) for that; `panels` is the
 * older row of titled boxes, kept for anything that is not about a party.
 *
 * The colour names below are kept for the pages that import them, and all of
 * them are black or white: a page that drew a navy heading or a tinted strip
 * with them prints black on white without being touched.
 */

export const NAVY = INK
export const TINT = '#fff'
export const TINT_SOFT = '#fff'
export { INK }
export const GREY = INK
export const MUTED = INK
export const RULE = INK
export const RULE_SOFT = INK
export const RED = INK

export { CODE, Dash, Eyebrow, Fact, NUM, longDate, money, qty, shortDate }
// The purchase order's own building blocks, for the part after the lines.
export { Band, Note, PartyLine, TaxByRate, Terms, TotalsBox, WordsAndTotals, type TotalLine }

/** A titled block. */
export function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return <Box title={title}>{children}</Box>
}

export interface SheetColumn {
  key: string
  head: string
  width: string
  align?: 'left' | 'right' | 'center'
}

/** The purchase order's "To," block: who the paper is for, and the document's own facts beside it. */
export interface SheetParty {
  /** "To," on most papers; "From," on a receipt or return. */
  heading?: string
  name: React.ReactNode
  code?: string | null
  /** Under the name: Address-, GST No, Contact No — `PartyLine`s. */
  lines?: React.ReactNode
  /** The column beside it: [label, value, mono?] — the number and date first. */
  meta: Array<[string, React.ReactNode, boolean?] | null | false>
}

/** A full-width band under the party: "Deliver to", "From store". */
export interface SheetBand {
  icon?: GlyphName
  label: string
  body: React.ReactNode
  /** A heavier rule, for an instruction that differs from the usual one. */
  strong?: boolean
}

export function StoreSheet({
  company,
  title,
  number,
  dateLabel,
  date,
  backHref,
  backLabel,
  banner,
  party,
  bands,
  panels = [],
  columns,
  rows,
  minRows = 0,
  after,
  signatures,
  footerNote,
  options,
  copyLabel,
  tagline,
  extraContact,
}: {
  company: Record<string, string | null>
  title: string
  /** The document's number: in the "To," block when there is one, else beside the title; and in the footer. */
  number: string
  dateLabel: string
  date: string
  backHref: string
  backLabel: string
  /** A band under the title, for a cancelled or closed document. */
  banner?: string | null
  /** The purchase order's "To," block. Given, the number and date print in it rather than beside the title. */
  party?: SheetParty
  bands?: Array<SheetBand | null | false>
  /** The older row of titled boxes, for facts that are not about a party. */
  panels?: Array<{ title: string; body: React.ReactNode }>
  columns: SheetColumn[]
  /**
   * `total`: a sub-total or total row, bold and ruled above (the job challan's
   * per-garment totals), `shade` greyed; `spans`/`covered`: a cell run down
   * over the rows below it (the garment over its rolls).
   */
  rows: Array<{
    key: string
    cells: Record<string, React.ReactNode>
    muted?: boolean
    total?: boolean
    shade?: boolean
    spans?: Record<string, number>
    covered?: string[]
  }>
  /** Ruled empty rows — only for a sheet meant to be written on (a count sheet). */
  minRows?: number
  /** Anything between the table and the signatures. */
  after?: React.ReactNode
  /** `sub` under the role ("For LD Cotton Mills"); `image` above it (a signature or stamp). */
  signatures: Array<{ role: string; who?: string | null; sub?: string | null; image?: string | null }>
  footerNote: string
  /** Screen-only controls above the sheet, never printed. */
  options?: React.ReactNode
  /** Which copy this is — "Original for the job worker" — printed over the number. */
  copyLabel?: string | null
  /** Letterhead extras, for the tax invoice: a line under the name, more contact rows. */
  tagline?: string | null
  extraContact?: Array<[string, string | null | undefined]>
}) {
  const cols: DocColumn[] = columns.map((c) => ({ key: c.key, head: c.head, width: c.width, align: c.align }))
  const shownBands = (bands ?? []).filter(Boolean) as SheetBand[]
  return (
    <DocumentSheet
      company={company}
      title={title}
      number={number}
      dateLabel={dateLabel}
      date={date}
      copyLabel={copyLabel}
      banner={banner}
      hideNumber={Boolean(party)}
      backHref={backHref}
      backLabel={backLabel}
      options={options}
      footerNote={footerNote}
      tagline={tagline}
      extraContact={extraContact}
    >
      {party && (
        <PartyBlock heading={party.heading} name={party.name} code={party.code} meta={party.meta}>
          {party.lines}
        </PartyBlock>
      )}

      {shownBands.map((b) => (
        <Band key={b.label} icon={b.icon} label={b.label} strong={b.strong}>
          {b.body}
        </Band>
      ))}

      {panels.length > 0 && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${panels.length}, minmax(0, 1fr))`,
            gap: '6px',
            marginTop: '7px',
          }}
        >
          {panels.map((p) => (
            <Panel key={p.title} title={p.title}>
              {p.body}
            </Panel>
          ))}
        </div>
      )}

      <DocTable columns={cols} rows={rows} minRows={minRows} />

      {after}

      <Signatures roles={signatures.map((s) => ({ role: s.role, who: s.who ?? null, sub: s.sub ?? null, image: s.image ?? null }))} />
    </DocumentSheet>
  )
}
