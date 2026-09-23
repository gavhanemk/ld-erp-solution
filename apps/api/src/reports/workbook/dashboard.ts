import type ExcelJS from 'exceljs'
import type { Panel, ReportAnalysis, ReportDefinition, ReportParams } from '../types'
import { CHART_COLOURS, sheetRef, type ChartSpec } from '../ooxml/chart-xml'
import { colLetter } from '../ooxml/pivot-xml'
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
 * Only a panel with nothing in it is a card.
 *
 * This used to be "fewer than two points", on the reasoning that one bar
 * carries no comparison. It is the wrong trade. A mill in its first month has
 * one supplier and one bill, so every panel had one point, and the whole
 * Dashboard degraded into a bulleted list with not one chart on it — at
 * exactly the moment somebody is deciding whether the thing works. A single
 * bar against a labelled axis still says what the figure is and what it is
 * counted in, and it grows into a real chart as the second supplier arrives
 * without the sheet changing shape underneath the reader.
 *
 * What genuinely cannot be drawn is a panel with no points at all.
 */
const isCard = (p: Panel) => p.points.length === 0

/**
 * Chart shape follows the question the panel asks, never the data it holds.
 *
 * The one exception is a shape that is a lie at small sizes. A doughnut of a
 * single slice is a circle labelled 100%; of two, it is a fact the eye reads
 * more accurately as two bars. Those fall back to bars — the question is
 * still "what are the shares", and the answer is still true, which is not
 * the case for a chart that cannot be read.
 */
function shapeFor(p: Panel): ChartSpec['kind'] {
  switch (p.question) {
    case 'trend':
      return p.points.length > 1 ? 'line' : 'column'
    case 'comparison':
      return 'column'
    case 'composition':
      return p.points.length >= 3 ? 'doughnut' : 'bar'
    case 'split':
      // A split with one segment is just the total, and a stack of one is a
      // plain bar that took a legend to say so.
      return p.series && p.series.length > 1 ? 'stackedBar' : 'bar'
    case 'pareto':
      // A running share over two names reaches 100% on the second one and
      // has told you nothing you could not see.
      return p.points.length >= 3 ? 'pareto' : 'bar'
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

  /*
   * Says so when there is barely anything to look at.
   *
   * A dashboard drawn over three rows is a row of single bars, and without
   * this line the reader's conclusion is that the report is broken rather
   * than that the period is empty. Cheaper to say it than to have somebody
   * spend an afternoon deciding which.
   */
  if (meta.rowCount > 0 && meta.rowCount < 5) {
    ws.mergeCells(row, 1, row, GRID)
    const thin = ws.getCell(row, 1)
    thin.value =
      `This period holds ${meta.rowCount} ${meta.rowCount === 1 ? 'row' : 'rows'}, so the charts ` +
      'below have very little to compare. They fill out as more documents are raised — nothing here is broken.'
    thin.font = { name: 'Calibri', size: 9, italic: true, color: { argb: TONE_INK.warn } }
    thin.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PAPER.warn } }
    thin.alignment = { wrapText: true, vertical: 'middle', indent: 1 }
    ws.getRow(row).height = 18
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
      const kind = shapeFor(p)
      const money = p.format === 'money'
      const scale = (v: number | null) => (v == null ? null : money ? toLakh(v) : v)
      const labels = p.points.map((pt) => pt.label)

      // Colour carries status. A ranking is one hue shaded by rank; red is
      // reserved for the points the report itself marked as exceptions.
      const pointColours = p.points.map((pt, n) =>
        pt.exception
          ? CHART_COLOURS.exception
          : CHART_COLOURS.rankShades[Math.min(n, CHART_COLOURS.rankShades.length - 1)]
      )

      /*
       * What the chart plots, which is not always one column of numbers.
       *
       * A stack plots one column per segment. A Pareto plots the values and
       * the share they have reached by that point, which is computed here
       * rather than asked of the report — it is arithmetic on the points the
       * report already gave, and two reports deriving it separately is two
       * chances to derive it differently.
       */
      let plotted: Array<{
        name: string
        values: Array<number | null>
        colour?: string
        pointColours?: string[]
      }>

      if (kind === 'stackedBar' && p.series) {
        plotted = p.series.map((s, n) => ({
          name: s.name,
          values: s.values.map(scale),
          colour: CHART_COLOURS.rankShades[n % CHART_COLOURS.rankShades.length],
        }))
      } else if (kind === 'pareto') {
        const total = p.points.reduce((s, pt) => s + pt.value, 0)
        let running = 0
        const share = p.points.map((pt) => {
          running += pt.value
          // Null, not nought, when there is nothing to divide by — a share
          // line sitting flat on zero reads as "nobody accounts for any of
          // it", which is a claim rather than an absence.
          return total > 0 ? Math.round((running / total) * 1000) / 1000 : null
        })
        plotted = [
          {
            name: money ? 'Value (₹ lakh)' : 'Value',
            values: p.points.map((pt) => scale(pt.value)),
            colour: CHART_COLOURS.primary,
            pointColours,
          },
          { name: 'Share reached', values: share },
        ]
      } else {
        plotted = [
          {
            name: p.title,
            values: p.points.map((pt) => scale(pt.value)),
            colour: CHART_COLOURS.primary,
            pointColours,
          },
        ]
      }

      const refs = hiddenWriter.write(
        p.title,
        labels,
        plotted.map((s) => ({ name: s.name, values: s.values }))
      )

      specs.push({
        kind,
        title: money ? `${p.title} — ₹ lakh` : p.title,
        categoriesRef: refs.categoriesRef,
        categories: labels,
        series: plotted.map((s, n) => ({
          name: s.name,
          valuesRef: refs.valueRefs[n],
          values: s.values,
          colour: s.colour,
          pointColours: s.pointColours,
        })),
        numFmt: money ? FMT.lakh : p.format === 'percent' ? FMT.percent : FMT.integer,
        anchor: {
          fromCol: left ? 0 : GRID / 2,
          fromRow: anchorRow - 1,
          toCol: left ? GRID / 2 : GRID,
          toRow: anchorRow - 1 + CHART_ROWS,
        },
        // A chart with more than one series has to name them, or the reader
        // is guessing which segment is which.
        showLegend: plotted.length > 1,
        // Three stacked segments put three numbers inside one bar, where they
        // collide with each other and with the boundaries between them.
        hideLabels: kind === 'stackedBar' && plotted.length > 2,
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
    const firstBodyRow = row
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

    /*
     * The grid, shaded by size.
     *
     * A block of forty numbers is a block of forty numbers: the eye reads
     * every one before it finds the big month. Shaded, the shape of the
     * trading year is there before a single figure is read — which is the
     * whole reason for laying it out as a grid instead of as a list.
     *
     * Two stops rather than three. A midpoint needs somebody to choose what
     * "middle" means, and a wrong midpoint reads as a judgement the report
     * never made. The cells holding a dash carry text, and a colour scale
     * passes over text, so a hole stays a hole.
     */
    if (m.rows.length && m.columns.length) {
      const lastBodyRow = row - 1
      const lastCol = colLetter(1 + m.columns.length)
      ws.addConditionalFormatting({
        ref: `B${firstBodyRow}:${lastCol}${lastBodyRow}`,
        rules: [
          {
            type: 'colorScale',
            priority: 1,
            cfvo: [{ type: 'min' }, { type: 'max' }],
            color: [{ argb: 'FFF1F5F9' }, { argb: `FF${CHART_COLOURS.primary}` }],
          },
        ],
      })
    }
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
