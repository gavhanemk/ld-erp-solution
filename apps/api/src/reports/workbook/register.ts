import ExcelJS from 'exceljs'
import type { Kpi, RegisterSpec, ReportAnalysis, ReportColumn, ReportDefinition } from '../types'
import type { AppliedFilter } from '../filters'
import { filterLine } from '../filters'
import {
  asDate,
  istDay,
  letterhead,
  type RegisterCompany,
  type RegisterTotal,
  type RegisterTotals,
} from '../register'
import type { SummaryGrid, SummaryValue } from '../summary'
import { BADGE_INK, BADGE_PAPER, colLetter } from './data'
import { FMT, INK, PAPER } from './theme'

/**
 * A report as a workbook of two sheets, and only two.
 *
 * **Summary** is the report screen's Summary tab in numbers: the headline,
 * the KPI figures, the totals tables and what needs attention. No charts,
 * no pivot — the accounts team asked for figures they can read straight off.
 *
 * **Data** is the detailed report. The letterhead and period sit above one
 * header row; every line follows as plain numbers and dates, so the sheet
 * sorts, filters and adds up like any other; the totals sit below, outside
 * the filter, where sorting cannot carry them off into the data.
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
  const d = asDate(v)
  if (!d) return null
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

type Line = { text: string; size: number; bold?: boolean; color?: string }

/** The letterhead, the title and the period, the same at the top of both sheets. */
function writeHead(ws: ExcelJS.Worksheet, lines: Line[]) {
  for (const l of lines) {
    const r = ws.addRow([l.text])
    r.getCell(1).font = { name: FONT, size: l.size, bold: l.bold, color: { argb: l.color ?? INK.heading } }
  }
  ws.addRow([])
}

/** A KPI's figure as a number Excel can still add, in the format it reads in. */
function kpiCell(k: { value: number | null; format: Kpi['format']; unit?: string }): {
  value: ExcelJS.CellValue
  numFmt?: string
} {
  if (k.value == null) return { value: '—' }
  switch (k.format) {
    case 'money':
      return { value: k.value, numFmt: FMT.moneySigned }
    case 'percent':
      return { value: k.value, numFmt: '0.0%' }
    case 'days':
      return { value: Math.round(k.value), numFmt: '0" days"' }
    case 'qty':
      return { value: k.value, numFmt: k.unit ? `#,##0.###" ${k.unit.replace(/"/g, '')}"` : '#,##0.###' }
    default:
      return { value: k.value, numFmt: '#,##0' }
  }
}

/** A quantity's unit rides in the number format, so the cell is still a number. */
function summaryCell(type: string, v: SummaryValue): { value: ExcelJS.CellValue; numFmt?: string } {
  if (v == null) return { value: null }
  if (Array.isArray(v)) {
    if (v.length === 0) return { value: null }
    if (v.length === 1) {
      return { value: v[0].value, numFmt: `${FORMAT.qty.split(';').pop()}" ${v[0].unit.replace(/"/g, '')}"` }
    }
    // Metres and pieces in one cell cannot be one number; they are words.
    return {
      value: v
        .map((u) => `${u.value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 3 })} ${u.unit}`)
        .join(' · '),
    }
  }
  if (type === 'money') return { value: v, numFmt: FORMAT.money }
  if (type === 'qty') return { value: v, numFmt: FORMAT.qty }
  return { value: v, numFmt: '#,##0' }
}

function buildSummarySheet(
  wb: ExcelJS.Workbook,
  head: Line[],
  analysis: ReportAnalysis | undefined,
  grids: SummaryGrid[]
) {
  const ws = wb.addWorksheet('Summary')
  const width = Math.max(3, ...grids.map((g) => g.figures.length + 3))
  ws.columns = Array.from({ length: width }, (_, i) => ({ width: i === 0 ? 34 : i === 2 && !grids.length ? 44 : 17 }))
  writeHead(ws, head)

  const section = (title: string) => {
    const r = ws.addRow([title])
    r.getCell(1).font = { name: FONT, size: 11, bold: true, color: { argb: INK.heading } }
    for (let i = 1; i <= width; i++) {
      r.getCell(i).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PAPER.brandSoft } }
    }
  }
  const header = (labels: string[], numericFrom: number) => {
    const r = ws.addRow(labels)
    r.eachCell((c, i) => {
      c.font = { name: FONT, size: 10, bold: true, color: { argb: INK.onBrand } }
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PAPER.header } }
      c.alignment = { vertical: 'middle', wrapText: true, horizontal: i > numericFrom ? 'right' : 'left' }
    })
    r.height = 22
  }
  const body = { name: FONT, size: 10, color: { argb: INK.body } }

  if (analysis?.headline) {
    const r = ws.addRow([analysis.headline])
    r.getCell(1).font = { name: FONT, size: 12, bold: true, color: { argb: INK.heading } }
    ws.addRow([])
  }

  // ── The period at a glance ──────────────────────────────────────────────
  if (analysis?.kpis.length) {
    section('The period at a glance')
    header(['Figure', 'Value', 'Based on'], 1)
    for (const k of analysis.kpis) {
      const v = kpiCell(k)
      const r = ws.addRow([k.label, v.value, k.basis])
      r.font = body
      if (v.numFmt) r.getCell(2).numFmt = v.numFmt
      r.getCell(2).alignment = { horizontal: 'right' }
      r.getCell(2).font = { ...body, bold: true }
      r.getCell(3).font = { name: FONT, size: 9, color: { argb: INK.muted } }
    }
    ws.addRow([])
  }

  // ── The totals ──────────────────────────────────────────────────────────
  for (const g of grids) {
    // "Job Worker" reads "job worker" mid-sentence; "HSN" stays "HSN".
    const inSentence = g.label
      .split(' ')
      .map((w) => (/^[A-Z]{2}/.test(w) ? w : w.charAt(0).toLowerCase() + w.slice(1)))
      .join(' ')
    section(`Totals by ${inSentence}`)
    header([g.label, g.counted, ...g.figures.map((f) => f.label), ...(g.shared ? ['Share'] : [])], 1)
    const write = (name: string, documents: number, values: SummaryValue[], share: number | null, total: boolean) => {
      const r = ws.addRow([name, documents])
      r.font = total ? { ...body, bold: true, color: { argb: INK.heading } } : body
      r.getCell(2).numFmt = '#,##0'
      g.figures.forEach((f, i) => {
        const c = summaryCell(f.type, values[i])
        const x = r.getCell(3 + i)
        x.value = c.value
        if (c.numFmt) x.numFmt = c.numFmt
        x.alignment = { horizontal: 'right' }
      })
      if (g.shared) {
        const x = r.getCell(3 + g.figures.length)
        x.value = share
        x.numFmt = '0.0%'
        x.alignment = { horizontal: 'right' }
      }
      if (total) {
        for (let i = 1; i <= 2 + g.figures.length + (g.shared ? 1 : 0); i++) {
          const x = r.getCell(i)
          x.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PAPER.brandSoft } }
          x.border = { top: { style: 'thin', color: { argb: INK.heading } }, bottom: { style: 'double', color: { argb: INK.heading } } }
        }
      }
    }
    for (const row of g.rows) write(row.name, row.documents, row.values, row.share, false)
    write('Total', g.total.documents, g.total.values, g.shared ? 1 : null, true)
    ws.addRow([])
  }

  // ── Needs attention ─────────────────────────────────────────────────────
  const live = (analysis?.exceptions ?? []).filter((e) => e.value != null && e.value !== 0)
  if (live.length) {
    section('Needs attention')
    header(['', 'Value', 'Note'], 1)
    for (const e of live) {
      const v = kpiCell(e)
      const r = ws.addRow([e.label, v.value, e.basis])
      r.font = body
      if (v.numFmt) r.getCell(2).numFmt = v.numFmt
      r.getCell(2).alignment = { horizontal: 'right' }
      r.getCell(2).font = { ...body, bold: true, color: { argb: e.tone === 'bad' ? 'FF991B1B' : 'FF92400E' } }
      r.getCell(3).font = { name: FONT, size: 9, color: { argb: INK.muted } }
    }
  }

  ws.pageSetup = {
    paperSize: 9,
    orientation: 'portrait',
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 },
  }
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
  /** The report's columns and register, every default filled in. */
  columns: ReportColumn[]
  spec: RegisterSpec
  rows: Array<Record<string, unknown>>
  totals: RegisterTotals
  /** The Summary sheet: the KPIs and what needs attention, and the totals tables. */
  analysis?: ReportAnalysis
  grids: SummaryGrid[]
  company: RegisterCompany | null
  periodLabel: string
  appliedFilters: AppliedFilter[]
  runBy: string
  /** Rows the query found, when more than were returned. */
  truncatedFrom?: number
}): Promise<Buffer> {
  const { def, columns: cols, spec, rows, totals, analysis, grids, company, periodLabel, appliedFilters, runBy, truncatedFrom } =
    opts
  const runAt = new Date()

  const wb = new ExcelJS.Workbook()
  wb.creator = 'LD Cotton Mills ERP'
  wb.created = runAt

  // ── Letterhead and period, at the top of both sheets ───────────────────
  const head = letterhead(company)
  const lines: Line[] = [
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
            text: `PARTIAL: the first ${rows.length.toLocaleString('en-IN')} of ${truncatedFrom.toLocaleString('en-IN')} rows. Narrow the period to see every row.`,
            size: 10,
            bold: true,
            color: 'FF991B1B',
          },
        ]
      : []),
  ]

  // Summary first, so the workbook opens on it as the report screen does.
  buildSummarySheet(wb, lines, analysis, grids)

  // Data starts on the first row: the headings in row 1, the first line in
  // row 2, nothing above them. The accounts team sorts, filters and pastes
  // this sheet, and lines of letterhead over it only got in the way. What the
  // sheet is and which period it covers stay on the Summary sheet, and in the
  // printed page's header.
  const ws = wb.addWorksheet('Data')
  ws.columns = cols.map((c) => ({ key: c.key, width: c.width ?? Math.max(10, c.label.length + 2) }))

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
  for (const [i, r] of rows.entries()) {
    // Without a document key every row is its own document.
    const key = spec.documentKey ? r[spec.documentKey] : i
    if (key !== lastKey) {
      doc++
      lastKey = key
    }
    const added = ws.addRow(cols.map((c) => cell(c, r[c.key])))
    const isVoid = spec.void != null && r[spec.void.key] === spec.void.value
    // Banded by document, not by row: a bill's lines read as one block, which
    // is how the eye finds where one bill ends and the next begins.
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
    const none = ws.addRow([`No ${spec.noun.many} match these filters.`])
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
  // The page header carries what the rows above the data used to say, on
  // paper only, so the sheet itself still starts at row 1. An "&" is doubled:
  // a single one starts a header code.
  const amp = (t: string) => t.replace(/&/g, '&&')
  ws.headerFooter = {
    oddHeader: `&L&9&B${amp(head.name)}&C&9&B${amp(def.title)}&R&9${amp(periodLabel)}`,
    oddFooter: `&L&8${amp(def.title)} · ${amp(periodLabel)}&C&8Generated ${RUN_AT.format(runAt)}&R&8Page &P of &N`,
  }

  return Buffer.from(await wb.xlsx.writeBuffer())
}
