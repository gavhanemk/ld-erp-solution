import type ExcelJS from 'exceljs'
import type { ReportAnalysis, ReportDefinition, ReportParams } from '../types'
import { INK, PAPER } from './theme'

/**
 * Who ran it, when, on what, and what every column means.
 *
 * The sheet that makes the file defensible three months later, when the
 * person holding it is not the person who ran it.
 */
export function buildNotes(
  wb: ExcelJS.Workbook,
  def: ReportDefinition,
  analysis: ReportAnalysis,
  params: ReportParams,
  meta: {
    runBy: string
    runAt: Date
    periodLabel: string
    rowCount: number
    truncatedFrom?: number
  }
) {
  const ws = wb.addWorksheet('Notes', { views: [{ showGridLines: false }] })
  ws.getColumn(1).width = 26
  ws.getColumn(2).width = 78

  let row = 1
  const heading = (text: string) => {
    ws.mergeCells(row, 1, row, 2)
    const c = ws.getCell(row, 1)
    c.value = text.toUpperCase()
    c.font = { name: 'Calibri', size: 9, bold: true, color: { argb: INK.muted } }
    c.border = { bottom: { style: 'thin', color: { argb: PAPER.rule } } }
    row += 1
  }
  const line = (label: string, value: string) => {
    const l = ws.getCell(row, 1)
    l.value = label
    l.font = { name: 'Calibri', size: 10, bold: true, color: { argb: INK.body } }
    l.alignment = { vertical: 'top' }
    const v = ws.getCell(row, 2)
    v.value = value
    v.font = { name: 'Calibri', size: 10, color: { argb: INK.body } }
    v.alignment = { wrapText: true, vertical: 'top' }
    row += 1
  }

  ws.mergeCells(row, 1, row, 2)
  const t = ws.getCell(row, 1)
  t.value = def.title
  t.font = { name: 'Calibri', size: 14, bold: true, color: { argb: INK.heading } }
  row += 2

  heading('How this file was made')
  line('Report', `${def.title} (${def.id})`)
  line('What it covers', def.description)
  line('Period', meta.periodLabel)
  line('Run by', meta.runBy)
  line('Run at', meta.runAt.toLocaleString('en-IN', { dateStyle: 'full', timeStyle: 'short' }))
  line('Rows', meta.rowCount.toLocaleString('en-IN'))

  // Truncation is allowed. Truncating quietly is not — the file name carries
  // _PARTIAL and this says by how much.
  if (meta.truncatedFrom) {
    const c = ws.getCell(row, 1)
    c.value = 'PARTIAL'
    c.font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FF991B1B' } }
    const v = ws.getCell(row, 2)
    v.value =
      `This file holds ${meta.rowCount.toLocaleString('en-IN')} of ${meta.truncatedFrom.toLocaleString('en-IN')} matching rows — ` +
      `${(meta.truncatedFrom - meta.rowCount).toLocaleString('en-IN')} were left out at the row ceiling. ` +
      'Narrow the filters and run it again to see the rest. The Dashboard figures describe only the rows that are here.'
    v.font = { name: 'Calibri', size: 10, color: { argb: 'FF991B1B' } }
    v.alignment = { wrapText: true, vertical: 'top' }
    ws.getRow(row).height = 30
    row += 1
  }
  row += 1

  heading('Filters applied')
  const applied = def.filters.filter((f) => params[f.key])
  if (applied.length === 0) {
    line('None', 'Every row the report can see is included.')
  } else {
    for (const f of applied) line(f.label, String(params[f.key]))
  }
  row += 1

  heading('What every column means')
  for (const c of def.columns) {
    const unit =
      c.type === 'money'
        ? 'rupees'
        : c.type === 'qty'
          ? c.unit
            ? `quantity in ${c.unit}`
            : 'quantity'
          : c.type === 'percent'
            ? 'percentage'
            : c.type === 'date'
              ? 'date'
              : c.type === 'integer'
                ? 'count'
                : 'text'
    line(c.label, `${unit}${c.total === 'sum' ? ' · totalled at the foot of the Data sheet' : ''}`)
  }
  row += 1

  if (analysis.caveats.length) {
    heading('What these figures do not show')
    for (const c of analysis.caveats) {
      ws.mergeCells(row, 1, row, 2)
      const cell = ws.getCell(row, 1)
      cell.value = `•  ${c}`
      cell.font = { name: 'Calibri', size: 10, color: { argb: INK.body } }
      cell.alignment = { wrapText: true, vertical: 'top' }
      row += 1
    }
    row += 1
  }

  heading('About the sheets')
  line('Dashboard', 'Describes the whole period, always. Its charts do not follow the Data filter.')
  line('Data', 'Every row. Filter and sort freely — the Dashboard will not move.')
  line(
    'Chart data',
    'Hidden. The numbers the Dashboard charts point at. A native chart must reference cells to stay editable, and pointing it at the Data sheet would make it change shape the moment anybody filtered the table.'
  )

  return ws
}
