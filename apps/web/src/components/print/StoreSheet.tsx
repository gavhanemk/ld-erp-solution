'use client'

import {
  Box,
  CODE,
  Dash,
  DocTable,
  DocumentSheet,
  Eyebrow,
  Fact,
  INK,
  NUM,
  Signatures,
  longDate,
  money,
  qty,
  type DocColumn,
} from '@/components/print/doc'

/**
 * The store's and the sales desk's printed papers — issue slip, transfer
 * note, count sheet, sales order, invoice, challan and the rest.
 *
 * Since 27 Nov 2026 every one of them is drawn by the shared document kit
 * (components/print/doc): the same black-and-white letterhead, title, ruled
 * boxes, line table, signatures and page footer as the purchase order. This
 * keeps the props it always had, so a page that used it needs no change.
 *
 * The colour names below are kept for the pages that import them, and all of
 * them are black or white now: a page that drew a navy heading or a tinted
 * strip with them prints black on white without being touched.
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

export { CODE, Dash, Eyebrow, Fact, NUM, longDate, money, qty }

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

export function StoreSheet({
  company,
  title,
  number,
  dateLabel,
  date,
  backHref,
  backLabel,
  banner,
  panels,
  columns,
  rows,
  minRows = 0,
  after,
  signatures,
  footerNote,
  options,
  copyLabel,
}: {
  company: Record<string, string | null>
  title: string
  /** The document's number, printed beside the title and in the footer. */
  number: string
  dateLabel: string
  date: string
  backHref: string
  backLabel: string
  /** A band under the title, for a cancelled or closed document. */
  banner?: string | null
  panels: Array<{ title: string; body: React.ReactNode }>
  columns: SheetColumn[]
  rows: Array<{ key: string; cells: Record<string, React.ReactNode>; muted?: boolean }>
  /** Ruled empty rows, for a sheet to be written on. */
  minRows?: number
  /** Anything between the table and the signatures. */
  after?: React.ReactNode
  signatures: Array<{ role: string; who?: string | null }>
  footerNote: string
  /** Screen-only controls above the sheet, never printed. */
  options?: React.ReactNode
  /** Which copy this is — "Original for the job worker" — printed over the number. */
  copyLabel?: string | null
}) {
  const cols: DocColumn[] = columns.map((c) => ({ key: c.key, head: c.head, width: c.width, align: c.align }))
  return (
    <DocumentSheet
      company={company}
      title={title}
      number={number}
      dateLabel={dateLabel}
      date={date}
      copyLabel={copyLabel}
      banner={banner}
      backHref={backHref}
      backLabel={backLabel}
      options={options}
      footerNote={footerNote}
    >
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

      <Signatures roles={signatures.map((s) => ({ role: s.role, who: s.who ?? null, sub: null }))} />
    </DocumentSheet>
  )
}
