import type ExcelJS from 'exceljs'
import type { Panel, ReportAnalysis, ReportDefinition, ReportParams } from '../types'
import { CHART_COLOURS, sheetRef, type ChartSpec } from '../ooxml/chart-xml'
import { FMT, INK, PAPER, TONE_INK, kpiText, toLakh } from './theme'

/**
 * Lays out the Dashboard and says where each chart goes.
 *
 * It returns chart *specs* as it goes — it is the only thing that knows both
 * where a chart belongs on the sheet and which cells on the hidden sheet hold
 * its numbers. The injector does the OOXML; nothing after this touches a cell.
 */

export const HIDDEN_SHEET = 'Chart data'
const GRID = 12 // columns A..L
const CHART_ROWS = 16
const CHART_COLS = 6

/** Where the next block of numbers starts on the hidden sheet. */
class HiddenSheet {
  private row = 1
  constructor(private ws: ExcelJS.Worksheet) {}

  /**
   * Writes a label column and one or more value columns, and hands back the
   * references a chart points at.
   */
  write(
    title: string,
    labels: string[],
    series: Array<{ name: string; values: Array<number | null> }>
  ) {
    this.ws.getCell(this.row, 1).value = title
    this.row++

    const headerRow = this.row
    this.ws.getCell(headerRow, 1).value = 'Label'
    series.forEach((s, i) => {
      this.ws.getCell(headerRow, 2 + i).value = s.name
    })
    this.row++

    const first = this.row
    labels.forEach((label, r) => {
      this.ws.getCell(first + r, 1).value = label
      series.forEach((s, i) => {
        const v = s.values[r]
        // A null is left as an empty cell, not written as nought — the chart
        // part caches it as a gap and Excel draws it as one.
        if (v != null) this.ws.getCell(first + r, 2 + i).value = v
      })
    })
    const last = first + labels.length - 1
    this.row = last + 3 // a blank line between blocks

    const col = (n: number) => String.fromCharCode(64 + n)
    return {
      categoriesRef: sheetRef(HIDDEN_SHEET, `$A$${first}:$A$${last}`),
      valueRefs: series.map((_, i) =>
        sheetRef(HIDDEN_SHEET, `$${col(2 + i)}$${first}:$${col(2 + i)}$${last}`)
      ),
    }
  }
}

function title(ws: ExcelJS.Worksheet, row: number, text: string, size: number, colour: string) {
  ws.mergeCells(row, 1, row, GRID)
  const c = ws.getCell(row, 1)
  c.value = text
  c.font = { name: 'Calibri', size, bold: true, color: { argb: colour } }
  c.alignment = { vertical: 'middle' }
}

function sectionRule(ws: ExcelJS.Worksheet, row: number, text: string) {
  ws.mergeCells(row, 1, row, GRID)
  const c = ws.getCell(row, 1)
  c.value = text.toUpperCase()
  c.font = { name: 'Calibri', size: 9, bold: true, color: { argb: INK.muted } }
  c.border = { bottom: { style: 'thin', color: { argb: PAPER.rule } } }
  c.alignment = { vertical: 'bottom' }
}

/**
 * A panel with one category is a card, not a chart.
 *
 * One bar carries no comparison, so the chart is pure decoration around a
 * number — and it costs the same fifteen rows as a chart that says something.
 */
const isCard = (p: Panel) => p.points.length < 2

/** Chart shape follows the question the panel asks, never the data it holds. */
function shapeFor(p: Panel): ChartSpec['kind'] {
  switch (p.question) {
    case 'trend':
      return 'line'
    case 'comparison':
      return 'column'
    case 'composition':
      return 'doughnut'
    default:
      return 'bar' // ranking, ageing, funnel
  }
}

export function buildDashboard(
  wb: ExcelJS.Workbook,
  def: ReportDefinition,
  analysis: ReportAnalysis,
  params: ReportParams,
  meta: { periodLabel: string; rowCount: number; truncatedFrom?: number }
): ChartSpec[] {
  const ws = wb.addWorksheet('Dashboard', {
    views: [{ showGridLines: false }],
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  })
  const hidden = wb.addWorksheet(HIDDEN_SHEET)
  const hiddenWriter = new HiddenSheet(hidden)
  const specs: ChartSpec[] = []

  for (let c = 1; c <= GRID; c++) ws.getColumn(c).width = 13

  // ── Masthead ──────────────────────────────────────────────────────────
  ws.getRow(1).height = 30
  title(ws, 1, def.title, 18, INK.heading)
  ws.mergeCells(2, 1, 2, GRID)
  const sub = ws.getCell(2, 1)
  sub.value = `${meta.periodLabel} · ${meta.rowCount.toLocaleString('en-IN')} rows${
    meta.truncatedFrom ? ` of ${meta.truncatedFrom.toLocaleString('en-IN')} (truncated)` : ''
  }`
  sub.font = { name: 'Calibri', size: 10, color: { argb: INK.muted } }

  let row = 4

  if (analysis.headline) {
    ws.mergeCells(row, 1, row, GRID)
    const h = ws.getCell(row, 1)
    h.value = analysis.headline
    h.font = { name: 'Calibri', size: 12, bold: true, color: { argb: PAPER.brand } }
    h.alignment = { wrapText: true, vertical: 'middle' }
    ws.getRow(row).height = 22
    row += 2
  }

  // ── KPI tiles, four across ────────────────────────────────────────────
  if (analysis.kpis.length) {
    sectionRule(ws, row, 'The period at a glance')
    row += 1
    const perTile = 3
    analysis.kpis.forEach((k, i) => {
      const tileRow = row + Math.floor(i / 4) * 4
      const c1 = 1 + (i % 4) * perTile
      const c2 = c1 + perTile - 1

      ws.mergeCells(tileRow, c1, tileRow, c2)
      const label = ws.getCell(tileRow, c1)
      label.value = k.label
      label.font = { name: 'Calibri', size: 9, bold: true, color: { argb: INK.muted } }
      label.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PAPER.card } }
      label.alignment = { vertical: 'middle', indent: 1 }

      ws.mergeCells(tileRow + 1, c1, tileRow + 1, c2)
      const value = ws.getCell(tileRow + 1, c1)
      value.value = kpiText(k)
      value.font = {
        name: 'Calibri',
        size: 16,
        bold: true,
        color: { argb: k.tone ? TONE_INK[k.tone] : INK.heading },
      }
      value.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: {
          argb: k.tone === 'bad' ? PAPER.bad : k.tone === 'warn' ? PAPER.warn : PAPER.card,
        },
      }
      value.alignment = { vertical: 'middle', indent: 1 }
      ws.getRow(tileRow + 1).height = 24

      // The denominator, always. A figure without one invites the reader to
      // supply their own.
      ws.mergeCells(tileRow + 2, c1, tileRow + 2, c2)
      const basis = ws.getCell(tileRow + 2, c1)
      basis.value = k.basis
      basis.font = { name: 'Calibri', size: 8, color: { argb: INK.muted } }
      basis.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PAPER.card } }
      basis.alignment = { vertical: 'top', indent: 1, wrapText: true }
    })
    row += Math.ceil(analysis.kpis.length / 4) * 4 + 1
  }

  // ── The headline trend, full width ────────────────────────────────────
  if (analysis.trend && analysis.trend.points.length > 1) {
    const t = analysis.trend
    sectionRule(ws, row, t.title)
    row += 1

    const money = t.format === 'money'
    const values = t.points.map((p) => (money ? toLakh(p.value) : p.value))
    const hasCompare = t.points.some((p) => p.compare != null)
    const compares = t.points.map((p) =>
      p.compare == null ? null : money ? toLakh(p.compare) : p.compare
    )

    const series = [
      { name: money ? `${t.valueLabel} (₹ lakh)` : t.valueLabel, values },
      ...(hasCompare ? [{ name: t.compareLabel ?? 'Previous', values: compares }] : []),
    ]
    const refs = hiddenWriter.write(
      t.title,
      t.points.map((p) => p.label),
      series
    )

    specs.push({
      kind: 'line',
      title: money ? `${t.title} — ₹ lakh` : t.title,
      categoriesRef: refs.categoriesRef,
      categories: t.points.map((p) => p.label),
      series: series.map((s, i) => ({
        name: s.name,
        valuesRef: refs.valueRefs[i],
        values: s.values,
        colour: i === 0 ? CHART_COLOURS.primary : CHART_COLOURS.compare,
      })),
      numFmt: money ? FMT.lakh : t.format === 'integer' ? FMT.integer : FMT.qty,
      anchor: { fromCol: 0, fromRow: row - 1, toCol: GRID, toRow: row - 1 + CHART_ROWS },
      showLegend: hasCompare,
    })
    row += CHART_ROWS + 1
  }

  // ── Panels, two across. Cards take one row each instead. ──────────────
  const cards = analysis.panels.filter(isCard)
  const charts = analysis.panels.filter((p) => !isCard(p))

  if (charts.length) {
    sectionRule(ws, row, 'Analysis')
    row += 1

    charts.forEach((p, i) => {
      const left = i % 2 === 0
      const anchorRow = row + Math.floor(i / 2) * (CHART_ROWS + 1)
      const money = p.format === 'money'
      const values = p.points.map((pt) => (money ? toLakh(pt.value) : pt.value))

      const refs = hiddenWriter.write(
        p.title,
        p.points.map((pt) => pt.label),
        [{ name: p.title, values }]
      )

      // Colour carries status. A ranking is one hue shaded by rank; red is
      // reserved for the points the report itself marked as exceptions.
      const pointColours = p.points.map((pt, n) =>
        pt.exception
          ? CHART_COLOURS.exception
          : CHART_COLOURS.rankShades[Math.min(n, CHART_COLOURS.rankShades.length - 1)]
      )

      specs.push({
        kind: shapeFor(p),
        title: money ? `${p.title} — ₹ lakh` : p.title,
        categoriesRef: refs.categoriesRef,
        categories: p.points.map((pt) => pt.label),
        series: [
          {
            name: p.title,
            valuesRef: refs.valueRefs[0],
            values,
            colour: CHART_COLOURS.primary,
            pointColours,
          },
        ],
        numFmt: money ? FMT.lakh : p.format === 'percent' ? FMT.percent : FMT.integer,
        anchor: {
          fromCol: left ? 0 : GRID / 2,
          fromRow: anchorRow - 1,
          toCol: left ? GRID / 2 : GRID,
          toRow: anchorRow - 1 + CHART_ROWS,
        },
        showLegend: false,
      })

      if (p.note) {
        const noteRow = anchorRow + CHART_ROWS - 1
        const c1 = left ? 1 : GRID / 2 + 1
        ws.mergeCells(noteRow, c1, noteRow, left ? GRID / 2 : GRID)
        const n = ws.getCell(noteRow, c1)
        n.value = p.note
        n.font = { name: 'Calibri', size: 8, italic: true, color: { argb: INK.muted } }
        n.alignment = { wrapText: true, vertical: 'top' }
      }
    })
    row += Math.ceil(charts.length / 2) * (CHART_ROWS + 1) + 1
  }

  if (cards.length) {
    sectionRule(ws, row, 'Single figures')
    row += 1
    cards.forEach((p) => {
      const pt = p.points[0]
      ws.mergeCells(row, 1, row, 4)
      const label = ws.getCell(row, 1)
      label.value = `${p.title}${pt ? ` · ${pt.label}` : ''}`
      label.font = { name: 'Calibri', size: 10, color: { argb: INK.body } }
      const value = ws.getCell(row, 5)
      value.value = pt ? pt.value : null
      value.numFmt = p.format === 'money' ? FMT.money : FMT.integer
      value.font = { name: 'Calibri', size: 11, bold: true, color: { argb: INK.heading } }
      if (!pt) {
        value.value = '—'
      }
      row += 1
    })
    row += 1
  }

  // ── The matrix, drawn as cells ────────────────────────────────────────
  if (analysis.matrix) {
    const m = analysis.matrix
    sectionRule(ws, row, m.title)
    row += 1
    ws.getCell(row, 1).value = m.rowLabel
    ws.getCell(row, 1).font = { name: 'Calibri', size: 9, bold: true, color: { argb: INK.muted } }
    m.columns.forEach((c, i) => {
      const cell = ws.getCell(row, 2 + i)
      cell.value = c
      cell.font = { name: 'Calibri', size: 9, bold: true, color: { argb: INK.muted } }
      cell.alignment = { horizontal: 'right' }
    })
    row += 1
    m.rows.forEach((r) => {
      ws.getCell(row, 1).value = r.label
      ws.getCell(row, 1).font = { name: 'Calibri', size: 10, color: { argb: INK.body } }
      r.values.forEach((v, i) => {
        const cell = ws.getCell(row, 2 + i)
        // A dash, not a nought — the cell could not be computed.
        cell.value = v == null ? '—' : v
        if (v != null) cell.numFmt = m.format === 'money' ? FMT.moneyWhole : FMT.integer
        cell.font = { name: 'Calibri', size: 10, color: { argb: INK.body } }
        cell.alignment = { horizontal: 'right' }
      })
      row += 1
    })
    row += 1
  }

  // ── Words ─────────────────────────────────────────────────────────────
  const words = (heading: string, lines: string[], colour: string) => {
    if (!lines.length) return
    sectionRule(ws, row, heading)
    row += 1
    lines.forEach((line) => {
      ws.mergeCells(row, 1, row, GRID)
      const c = ws.getCell(row, 1)
      c.value = `•  ${line}`
      c.font = { name: 'Calibri', size: 10, color: { argb: colour } }
      c.alignment = { wrapText: true, vertical: 'top' }
      ws.getRow(row).height = 16
      row += 1
    })
    row += 1
  }

  words('What the figures show', analysis.insights, INK.body)
  // Caveats print on the Dashboard, not only in Notes. A caveat nobody reads
  // is a caveat that did not happen.
  words('What they do not show', analysis.caveats, TONE_INK.warn)

  // ── The footnote the hidden sheet earns ───────────────────────────────
  ws.mergeCells(row, 1, row, GRID)
  const foot = ws.getCell(row, 1)
  foot.value =
    `The charts above read from a hidden sheet named "${HIDDEN_SHEET}", so they keep describing the whole period ` +
    'even when the Data sheet is filtered. Unhide it to see or edit those numbers.'
  foot.font = { name: 'Calibri', size: 8, italic: true, color: { argb: INK.muted } }
  foot.alignment = { wrapText: true, vertical: 'top' }

  // Hidden last, so every write above happened on a visible sheet.
  hidden.state = 'hidden'
  hidden.getColumn(1).width = 34
  for (let c = 2; c <= 6; c++) hidden.getColumn(c).width = 16

  return specs
}
