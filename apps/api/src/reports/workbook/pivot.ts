import type ExcelJS from 'exceljs'
import type { ReportColumn, ReportDefinition } from '../types'
import { INK } from './theme'
import { DATA_SHEET, formatFor, plainCell } from './data'
import { colLetter, type PivotFieldPlan, type PivotPlan } from '../ooxml/pivot-xml'

/**
 * The sheet where the reader does their own grouping.
 *
 * The Dashboard answers the questions the report thought of. This answers the
 * ones it did not: a real PivotTable over the same rows, which somebody can
 * re-field, re-sort and filter without going back to whoever built the report.
 *
 * It holds the pivot and a heading and nothing else, because the pivot's range
 * grows and shrinks as it is used and anything parked beside it is something
 * Excel will refuse to write over.
 */

export const PIVOT_SHEET = 'Pivot'

/**
 * How many distinct values are worth offering as a filter.
 *
 * A slicer is a panel of buttons. Six hundred buttons is not a filter, it is a
 * scrollbar with a search box already beside it on the Data sheet — so past
 * this the column keeps its place in the pivot and loses its slicer.
 */
const SLICER_ITEM_CAP = 500

export function buildPivot(
  wb: ExcelJS.Workbook,
  def: ReportDefinition,
  rows: Array<Record<string, unknown>>
): PivotPlan | null {
  const spec = def.pivot
  if (!spec || rows.length === 0) return null

  // A cache field is found by its header text, so two columns sharing a label
  // give a cache whose second field shadows the first — and a pivot that
  // totals the wrong column while looking entirely reasonable.
  const labels = def.columns.map((c) => c.label)
  const duplicate = labels.find((l, i) => labels.indexOf(l) !== i)
  if (duplicate) {
    console.warn(`[reports] ${def.id}: no Pivot sheet — two columns are both called "${duplicate}"`)
    return null
  }

  const indexOf = (key: string) => def.columns.findIndex((c) => c.key === key)

  const wantedRows = Array.isArray(spec.rows) ? spec.rows : [spec.rows]
  const rowFields = wantedRows.map(indexOf)
  const unknown = wantedRows.filter((_, i) => rowFields[i] < 0)
  if (unknown.length) {
    console.warn(`[reports] ${def.id}: no Pivot sheet — no column keyed "${unknown[0]}"`)
    return null
  }

  const measures = spec.values
    .map(indexOf)
    .filter((i) => i >= 0 && isNumeric(def.columns[i]))
    .map((i) => ({
      field: i,
      label: `Sum of ${def.columns[i].label}`,
      numFmt: formatFor(def.columns[i]) ?? 'General',
    }))

  if (measures.length === 0) {
    console.warn(`[reports] ${def.id}: no Pivot sheet — none of its value columns add up`)
    return null
  }

  // ── The fields, as the cache sees them ────────────────────────────────────
  //
  // Only a field on an axis or behind a slicer gets shared items. Everything
  // else carries its value inline in the records, which keeps that part the
  // size of the data rather than the data plus an index nothing reads.
  const wanted = new Set([...rowFields, ...(spec.slicers ?? []).map(indexOf).filter((i) => i >= 0)])

  const fields: PivotFieldPlan[] = def.columns.map((c, i) => {
    const kind = isNumeric(c) ? 'number' : c.type === 'date' ? 'date' : 'text'
    const field: PivotFieldPlan = { name: c.label, kind }

    if (wanted.has(i) && kind === 'text') {
      const seen = new Set<string>()
      let blank = false
      for (const r of rows) {
        const v = plainCell(c, r[c.key])
        if (v == null) blank = true
        else seen.add(String(v))
      }
      // Sorted, so the indices the cache hands out are already the order
      // Excel would put the items in — the pivot then reads correctly before
      // it has been refreshed as well as after.
      field.items = [...seen].sort((a, b) => a.localeCompare(b, 'en-IN'))
      field.blank = blank
    } else if (kind === 'number') {
      let min = Infinity
      let max = -Infinity
      let blank = false
      for (const r of rows) {
        const v = plainCell(c, r[c.key])
        if (typeof v === 'number') {
          if (v < min) min = v
          if (v > max) max = v
        } else blank = true
      }
      if (min !== Infinity) {
        field.min = min
        field.max = max
      }
      field.blank = blank
    } else {
      field.blank = rows.some((r) => plainCell(c, r[c.key]) == null)
    }

    return field
  })

  const slicerFields = [...wanted].filter(
    (i) =>
      !rowFields.includes(i) &&
      (fields[i].items?.length ?? 0) > 0 &&
      fields[i].items!.length <= SLICER_ITEM_CAP
  )

  // ── The sheet ─────────────────────────────────────────────────────────────
  const at = { row: 6, col: 1 }
  const ws = wb.addWorksheet(PIVOT_SHEET)
  ws.getColumn(1).width = 34
  measures.forEach((_, i) => {
    ws.getColumn(2 + i).width = 18
  })

  const grouping = rowFields.map((i) => def.columns[i].label)
  heading(ws, 1, def.title, 14, INK.heading)
  heading(
    ws,
    2,
    `Grouped by ${grouping.join(', then ')}. Drag any field to regroup it — ` +
      'the figures come from the Data sheet, so they always agree with it.',
    10,
    INK.muted
  )
  if (spec.note) heading(ws, 4, spec.note, 10, INK.body)

  ws.views = [{ showGridLines: false }]

  // The cache reads the header row and the data rows — never the totals row
  // the Data sheet ends on. Counting a total as one more row of data is how a
  // pivot comes out at exactly twice the real figure.
  const lastDataRow = rows.length + 1
  const sourceRef = `A1:${colLetter(def.columns.length)}${lastDataRow}`

  return {
    tableName: 'PurchasePivot',
    cacheId: 1,
    sheet: PIVOT_SHEET,
    sourceSheet: DATA_SHEET,
    sourceRef,
    fields,
    rowFields,
    dataFields: measures,
    slicerFields,
    at,
    // A generator, not an array: the rows are walked once on the way into the
    // XML rather than copied into a second structure beside the one ExcelJS
    // is already holding.
    records: {
      *[Symbol.iterator]() {
        for (const r of rows) yield def.columns.map((c) => plainCell(c, r[c.key]))
      },
    },
    recordCount: rows.length,
  }
}

function isNumeric(c: ReportColumn): boolean {
  return c.type === 'money' || c.type === 'qty' || c.type === 'integer' || c.type === 'percent'
}

function heading(
  ws: ExcelJS.Worksheet,
  row: number,
  text: string,
  size: number,
  colour: string
): void {
  const cell = ws.getCell(row, 1)
  cell.value = text
  cell.font = { name: 'Calibri', size, bold: size > 11, color: { argb: colour } }
  cell.alignment = { vertical: 'middle' }
  if (size > 11) ws.getRow(row).height = 22
}
