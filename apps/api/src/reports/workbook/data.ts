import type ExcelJS from 'exceljs'
import type { ReportColumn, ReportDefinition } from '../types'
import { FMT, INK, PAPER, numberFormatFor } from './theme'

/**
 * Every row, one header, an autofilter.
 *
 * This is the sheet somebody opens to check a figure they doubt, so nothing
 * here is rounded, scaled or abbreviated. The Dashboard plots lakhs; this
 * prints rupees.
 */
export function buildData(
  wb: ExcelJS.Workbook,
  def: ReportDefinition,
  rows: Array<Record<string, unknown>>
) {
  const ws = wb.addWorksheet('Data', {
    views: [{ state: 'frozen', ySplit: 1 }],
  })

  ws.columns = def.columns.map((c) => ({
    header: c.label,
    key: c.key,
    width: c.width ?? Math.min(38, Math.max(10, c.label.length + 4)),
  }))

  const header = ws.getRow(1)
  header.height = 20
  header.eachCell((cell) => {
    cell.font = { name: 'Calibri', size: 10, bold: true, color: { argb: INK.onBrand } }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PAPER.header } }
    cell.alignment = { vertical: 'middle', wrapText: true }
  })

  for (const r of rows) {
    const added = ws.addRow(def.columns.map((c) => cellValue(c, r[c.key])))
    added.font = { name: 'Calibri', size: 10, color: { argb: INK.body } }
    def.columns.forEach((c, i) => {
      const cell = added.getCell(i + 1)
      const fmt = formatFor(c)
      if (fmt) cell.numFmt = fmt
      if (c.type === 'money' || c.type === 'qty' || c.type === 'integer' || c.type === 'percent') {
        cell.alignment = { horizontal: 'right' }
      }
    })
  }

  // Totals, only where the column said it adds up. There is deliberately no
  // average: a mean of a column nobody weighted looks like an answer and is
  // not one.
  const totalled = def.columns.some((c) => c.total === 'sum')
  if (totalled && rows.length) {
    const first = 2
    const last = rows.length + 1
    const totals = ws.addRow(
      def.columns.map((c, i) =>
        c.total === 'sum'
          ? { formula: `SUBTOTAL(109,${colLetter(i + 1)}${first}:${colLetter(i + 1)}${last})` }
          : i === 0
            ? `Total · ${rows.length.toLocaleString('en-IN')} rows`
            : null
      )
    )
    totals.font = { name: 'Calibri', size: 10, bold: true, color: { argb: INK.heading } }
    totals.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PAPER.brandSoft } }
      cell.border = { top: { style: 'thin', color: { argb: PAPER.rule } } }
    })
    def.columns.forEach((c, i) => {
      const fmt = formatFor(c)
      if (c.total === 'sum' && fmt) totals.getCell(i + 1).numFmt = fmt
    })
  }

  // The filter covers the data only — including the totals row would let
  // somebody filter the total away, or worse, filter it into a subset.
  if (rows.length) {
    ws.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: rows.length + 1, column: def.columns.length },
    }
  }

  return ws
}

/**
 * The unit rides in the number format, not in the text.
 *
 * "1,250 mtr" typed as a string is a quantity nobody can add up. As a format
 * the cell is still the number 1250, sums correctly, and still reads with its
 * unit — which is the whole reason for wanting the unit there.
 */
function formatFor(c: ReportColumn): string | undefined {
  const base = numberFormatFor(c.type)
  if (!base) return undefined
  if (c.type === 'qty' && c.unit) return `${base}" ${c.unit}"`
  return base
}

function cellValue(c: ReportColumn, v: unknown): ExcelJS.CellValue {
  if (v == null || v === '') return null
  if (c.type === 'date') {
    const d = v instanceof Date ? v : new Date(String(v))
    return Number.isNaN(d.getTime()) ? null : d
  }
  if (c.type === 'badge') return c.badges?.[String(v)] ?? String(v)
  if (c.type === 'money' || c.type === 'qty' || c.type === 'integer' || c.type === 'percent') {
    const n = Number(v)
    return Number.isNaN(n) ? null : n
  }
  return String(v)
}

function colLetter(n: number): string {
  let s = ''
  while (n > 0) {
    const r = (n - 1) % 26
    s = String.fromCharCode(65 + r) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

export { FMT }
