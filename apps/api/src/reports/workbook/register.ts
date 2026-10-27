import ExcelJS from 'exceljs'
import type { ReportColumn, ReportDefinition } from '../types'
import type { AppliedFilter } from '../filters'
import { filterLine } from '../filters'
import {
  istDay,
  letterhead,
  type RegisterCompany,
  type RegisterTotal,
  type RegisterTotals,
} from '../register'
import { BADGE_INK, BADGE_PAPER, colLetter } from './data'
import { FMT, INK, PAPER } from './theme'

/**
 * A register as one worksheet, named for the register.
 *
 * No Dashboard, Pivot or Notes behind it: the accounts team asked for the
 * register and nothing else. The letterhead and period sit above one header
 * row; every line follows as plain numbers and dates, so the sheet sorts,
 * filters and adds up like any other; the totals sit below, outside the
 * filter, where sorting cannot carry them off into the data.
 */

const FONT = 'Calibri'

const FORMAT = {
  money: FMT.money,
  qty: '[>=10000000]##\\,##\\,##\\,##0.00#;[>=100000]##\\,##\\,##0.00#;##,##0.00#',
  integer: '0',
  percent: '0.0%',
  date: 'dd/mm/yyyy',
} as const

function formatOf(c: ReportColumn): string | undefined {
  switch (c.type) {
    case 'money':
      return FORMAT.money
    case 'qty':
      return FORMAT.qty
    case 'integer':
      return FORMAT.integer
    case 'percent':
      return FORMAT.percent
    case 'date':
      return FORMAT.date
    default:
      return undefined
  }
}

const NUMERIC = new Set(['money', 'qty', 'integer', 'percent'])

/**
 * A date as the calendar day it is in India, held at midnight UTC.
 *
 * Excel has no time zones; it shows a date's UTC day. A bill saved at 1:30
 * on the morning of 1 May is 30 April in UTC, so it is moved onto its Indian
 * day first — the day the screen and the PDF print.
 */
function excelDate(v: unknown): Date | null {
  const d = v instanceof Date ? v : v ? new Date(String(v)) : null
  if (!d || Number.isNaN(d.getTime())) return null
  const [y, m, day] = istDay(d).split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, day))
}

function cell(c: ReportColumn, v: unknown): ExcelJS.CellValue {
  if (v == null || v === '') return null
  if (c.type === 'date') return excelDate(v)
  if (c.type === 'badge') return c.badges?.[String(v)] ?? String(v)
  if (NUMERIC.has(c.type)) {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return String(v)
}

/** A total for a quantity column: one number if one unit, else each unit in words. */
function qtyTotal(t: RegisterTotal, c: ReportColumn): number | string | null {
  const units = t.byUnit[c.key]
  if (!units?.length) return null
  if (units.length === 1) return units[0].value
  return units
    .map((u) => `${u.value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 3 })} ${u.unit}`)
    .join(' · ')
}

const RUN_AT = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'Asia/Kolkata',
})

export async function buildRegisterWorkbook(opts: {
  def: ReportDefinition
  rows: Array<Record<string, unknown>>
  totals: RegisterTotals
  company: RegisterCompany | null
  periodLabel: string
  appliedFilters: AppliedFilter[]
  runBy: string
  /** Rows the query found, when more than were returned. */
  truncatedFrom?: number
}): Promise<Buffer> {
  const { def, rows, totals, company, periodLabel, appliedFilters, runBy, truncatedFrom } = opts
  const spec = def.register
  if (!spec) throw new Error(`${def.id} is not a register`)
  const cols = def.columns
  const runAt = new Date()

  const wb = new ExcelJS.Workbook()
  wb.creator = 'LD Cotton Mills ERP'
  wb.created = runAt

  const ws = wb.addWorksheet(def.title.slice(0, 31))
  ws.columns = cols.map((c) => ({ key: c.key, width: c.width ?? Math.max(10, c.label.length + 2) }))

  // ── Letterhead and period ───────────────────────────────────────────────
  const head = letterhead(company)
  const lines: Array<{ text: string; size: number; bold?: boolean; color?: string }> = [
    ...(head.name ? [{ text: head.name, size: 14, bold: true }] : []),
    ...head.lines.map((text) => ({ text, size: 9, color: INK.muted })),
    { text: def.title, size: 13, bold: true },
    { text: `Period: ${periodLabel}`, size: 10 },
    { text: filterLine(appliedFilters), size: 9, color: INK.muted },
    {
      text: `Generated on ${RUN_AT.format(runAt)} by ${runBy}   ·   Amounts in ₹`,
      size: 9,
      color: INK.muted,
    },
    ...(truncatedFrom
      ? [
          {
            text: `PARTIAL: the first ${rows.length.toLocaleString('en-IN')} of ${truncatedFrom.toLocaleString('en-IN')} lines. Narrow the period to see every line.`,
            size: 10,
            bold: true,
            color: 'FF991B1B',
          },
        ]
      : []),
  ]
  for (const l of lines) {
    const r = ws.addRow([l.text])
    r.getCell(1).font = { name: FONT, size: l.size, bold: l.bold, color: { argb: l.color ?? INK.heading } }
  }
  ws.addRow([])

  // ── The header row ──────────────────────────────────────────────────────
  const header = ws.addRow(cols.map((c) => c.label))
  const headerRow = header.number
  header.height = 30
  header.eachCell((c, i) => {
    c.font = { name: FONT, size: 10, bold: true, color: { argb: INK.onBrand } }
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PAPER.header } }
    c.alignment = {
      vertical: 'middle',
      wrapText: true,
      horizontal: NUMERIC.has(cols[i - 1].type) ? 'right' : 'left',
    }
  })

  // ── Every line ──────────────────────────────────────────────────────────
  const firstData = headerRow + 1
  let doc = -1
  let lastKey: unknown = Symbol('none')
  for (const r of rows) {
    if (r[spec.documentKey] !== lastKey) {
      doc++
      lastKey = r[spec.documentKey]
    }
    const added = ws.addRow(cols.map((c) => cell(c, r[c.key])))
    const isVoid = spec.void != null && r[spec.void.key] === spec.void.value
    // Banded by bill, not by row: a bill's lines read as one block, which is
    // how the eye finds where one bill ends and the next begins.
    const banded = doc % 2 === 1
    cols.forEach((c, i) => {
      const x = added.getCell(i + 1)
      x.font = { name: FONT, size: 10, color: { argb: isVoid ? INK.muted : INK.body } }
      const fmt = formatOf(c)
      if (fmt) x.numFmt = fmt
      if (NUMERIC.has(c.type)) x.alignment = { horizontal: 'right' }
      const tone = c.type === 'badge' ? c.badgeTones?.[String(r[c.key])] : undefined
      if (tone) {
        x.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BADGE_PAPER[tone] } }
        x.font = { name: FONT, size: 10, bold: true, color: { argb: BADGE_INK[tone] } }
      } else if (banded) {
        x.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PAPER.card } }
      }
    })
  }
  const lastData = firstData + rows.length - 1

  // The filter and the frozen header cover the data only — a totals row
  // inside the filter could be filtered away, or sorted into the middle.
  ws.views = [{ state: 'frozen', ySplit: headerRow }]
  if (rows.length) {
    ws.autoFilter = {
      from: { row: headerRow, column: 1 },
      to: { row: lastData, column: cols.length },
    }
  }

  // ── Totals ──────────────────────────────────────────────────────────────
  const styleTotal = (row: ExcelJS.Row, strong: boolean) => {
    cols.forEach((c, i) => {
      const x = row.getCell(i + 1)
      x.font = { name: FONT, size: 10, bold: true, color: { argb: INK.heading } }
      x.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PAPER.brandSoft } }
      x.border = strong
        ? { top: { style: 'thin', color: { argb: INK.heading } }, bottom: { style: 'double', color: { argb: INK.heading } } }
        : { top: { style: 'thin', color: { argb: PAPER.rule } } }
      const fmt = formatOf(c)
      if (fmt && c.total === 'sum') x.numFmt = fmt
      if (NUMERIC.has(c.type)) x.alignment = { horizontal: 'right' }
    })
  }

  if (rows.length) {
    /*
     * The grand total adds up what is showing. SUBTOTAL(109) skips rows the
     * reader has filtered out, so filtering to one supplier turns this row
     * into that supplier's total — the first thing anybody does with a
     * register in Excel. The value it opens with is the engine's own total,
     * the same figure the PDF prints.
     */
    const grand = ws.addRow(
      cols.map((c, i) => {
        if (i === 0) return `Grand total · ${totals.grand.count}`
        if (c.total !== 'sum') return null
        if (c.type === 'qty' && c.unitKey) {
          const q = qtyTotal(totals.grand, c)
          // One unit adds up; several cannot, and print as words instead.
          if (typeof q !== 'number') return q
        }
        const L = colLetter(i + 1)
        return {
          formula: `SUBTOTAL(109,${L}${firstData}:${L}${lastData})`,
          result: c.type === 'qty' ? qtyTotal(totals.grand, c) : totals.grand.sums[c.key],
        } as ExcelJS.CellFormulaValue
      })
    )
    styleTotal(grand, true)
    grand.getCell(1).alignment = { horizontal: 'left' }

    if (totals.months.length) {
      ws.addRow([])
      const caption = ws.addRow(['Totals by month'])
      caption.getCell(1).font = { name: FONT, size: 11, bold: true, color: { argb: INK.heading } }
      for (const m of totals.months) {
        const row = ws.addRow(
          cols.map((c, i) => {
            if (i === 0) return `${m.label} · ${m.count}`
            if (c.total !== 'sum') return null
            return c.type === 'qty' && c.unitKey ? qtyTotal(m, c) : (m.sums[c.key] ?? null)
          })
        )
        styleTotal(row, false)
        row.getCell(1).alignment = { horizontal: 'left' }
      }
    }
  } else {
    const none = ws.addRow(['No bills match these filters.'])
    none.getCell(1).font = { name: FONT, size: 10, italic: true, color: { argb: INK.muted } }
  }

  // ── Paper, for whoever prints the sheet from Excel ──────────────────────
  ws.pageSetup = {
    paperSize: 9, // A4
    orientation: 'landscape',
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    margins: { left: 0.3, right: 0.3, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 },
    printTitlesRow: `${headerRow}:${headerRow}`,
  }
  ws.headerFooter = {
    oddFooter: `&L&8${def.title} · ${periodLabel}&C&8Generated ${RUN_AT.format(runAt)}&R&8Page &P of &N`,
  }

  return Buffer.from(await wb.xlsx.writeBuffer())
}
