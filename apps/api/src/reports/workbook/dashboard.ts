import type ExcelJS from 'exceljs'
import type { Panel, ReportAnalysis, ReportDefinition, ReportParams } from '../types'
import { CHART_COLOURS, sheetRef, type ChartSpec } from '../ooxml/chart-xml'
import { colLetter } from '../ooxml/pivot-xml'
import { FMT, INK, PAPER, TONE_INK, kpiText, toLakh } from './theme'
import { BADGE_INK, BADGE_PAPER, formatFor, plainCell } from './data'
import { filterLine, type AppliedFilter } from '../filters'

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
const isCard = (p: Panel) => p.points.length < 2

/**
 * A panel that would draw a chart saying nothing, and is dropped outright.
 *
 * A Pareto over two names reaches 100% on the second one, and the bars it
 * draws are the same bars the ranking panel beside it already drew — the same
 * information twice, which is worse than not drawing it. Falling back to a
 * plain bar was the original behaviour and produced exactly that duplicate.
 */
const isPointless = (p: Panel) => p.question === 'pareto' && p.points.length < 3

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
  meta: {
    periodLabel: string
    rowCount: number
    truncatedFrom?: number
    appliedFilters?: AppliedFilter[]
  },
  /** For the management extract at the foot. The Data sheet still has them all. */
  rows: Array<Record<string, unknown>> = []
): ChartSpec[] {
  const ws = wb.addWorksheet('Dashboard', {
    views: [{ showGridLines: false }],
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  })
  const hidden = wb.addWorksheet(HIDDEN_SHEET)
  const hiddenWriter = new HiddenSheet(hidden)
  const specs: ChartSpec[] = []

  /*
   * A white sheet, said out loud.
   *
   * Excel's default is white, so this looks like it changes nothing — until
   * the file is opened by somebody whose workbook theme is not the default,
   * or printed, or pasted into a deck. The pack should look the same
   * everywhere it is read, and a column fill is one style each rather than a
   * fill on every cell, which is the difference between a few bytes and a few
   * hundred kilobytes on a sheet this tall.
   *
   * Set before anything is written, so every tint below overrides it.
   */
  for (let c = 1; c <= GRID; c++) {
    const col = ws.getColumn(c)
    col.width = 13
    col.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } }
  }

  // ── Masthead ──────────────────────────────────────────────────────────
  ws.getRow(1).height = 30
  title(ws, 1, def.title, 18, INK.heading)
  ws.mergeCells(2, 1, 2, GRID)
  const sub = ws.getCell(2, 1)
  sub.value = `${meta.periodLabel} · ${meta.rowCount.toLocaleString('en-IN')} rows${
    meta.truncatedFrom ? ` of ${meta.truncatedFrom.toLocaleString('en-IN')} (truncated)` : ''
  }`
  sub.font = { name: 'Calibri', size: 10, color: { argb: INK.muted } }

  /*
   * The filters, on the face of the sheet.
   *
   * The Notes tab has always recorded them, and a tab nobody opens is a tab
   * that did not record anything. A figure that looks wrong and a supplier
   * filter left set are the same picture until this line is read, and by the
   * time the file has been mailed on, whoever reads it never saw the screen
   * it was run from.
   */
  ws.mergeCells(3, 1, 3, GRID)
  const applied = ws.getCell(3, 1)
  applied.value = filterLine(meta.appliedFilters ?? [])
  applied.font = {
    name: 'Calibri',
    size: 9,
    italic: (meta.appliedFilters ?? []).length === 0,
    color: { argb: (meta.appliedFilters ?? []).length ? INK.body : INK.muted },
  }
  applied.alignment = { vertical: 'middle' }

  let row = 5

  if (analysis.headline) {
    /*
     * The headline, given the weight it is worth.
     *
     * It was brand-coloured text on bare paper, at twelve point — the same
     * visual weight as the caveat under it and less than the block of tiles
     * below, so the one sentence summarising the period was not where the eye
     * landed. On its own tinted band, a size up, with a rule down the left in
     * the brand colour, it is the entry point to the sheet. The screen's
     * dashboard now opens exactly the same way; a report that reads one way in
     * the browser and another in Excel is two reports to learn.
     */
    ws.mergeCells(row, 1, row, GRID)
    const h = ws.getCell(row, 1)
    h.value = analysis.headline
    h.font = { name: 'Calibri', size: 14, bold: true, color: { argb: INK.heading } }
    h.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PAPER.brandSoft } }
    h.alignment = { wrapText: true, vertical: 'middle', indent: 1 }
    h.border = { left: { style: 'thick', color: { argb: PAPER.brand } } }
    ws.getRow(row).height = 30
    // The band is one merged cell, so the fill has to be painted across the
    // constituent cells or it stops at the first column.
    for (let c = 2; c <= GRID; c++) {
      ws.getCell(row, c).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: PAPER.brandSoft },
      }
    }
    row += 2
  }

  /*
   * Says so when there is barely anything to look at — and says which of the
   * two things actually happened.
   *
   * A dashboard drawn over three rows is a row of single bars, and without a
   * line like this the reader's conclusion is that the report is broken rather
   * than that the period is empty.
   *
   * It used to promise "the charts below", which on a young period is a
   * promise the split further down then breaks: every panel holding one
   * category becomes a tile, so a reader told to look at the charts finds a
   * heading saying Single figures and no chart anywhere. That reads as the
   * failure the line exists to rule out. It now counts the split first and
   * names what is really there.
   */
  const panelsUsable = analysis.panels.filter((p) => !isPointless(p))
  const panelsAsCards = panelsUsable.filter(isCard).length
  const panelsAsCharts = panelsUsable.length - panelsAsCards

  if (meta.rowCount > 0 && meta.rowCount < 5) {
    ws.mergeCells(row, 1, row, GRID)
    const thin = ws.getCell(row, 1)
    const rows = `${meta.rowCount} ${meta.rowCount === 1 ? 'row' : 'rows'}`
    thin.value =
      panelsAsCharts === 0 && panelsAsCards > 0
        ? `This period holds ${rows}, and every figure below has a single thing in it — one ` +
          'supplier, one status. A chart of one bar says less than the number does, so they are ' +
          'shown as numbers. Charts appear once there is more than one of something to compare.'
        : `This period holds ${rows}, so the charts below have very little to compare. They fill ` +
          'out as more documents are raised — nothing here is broken.'
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

      /*
       * A rail down the left of each tile, in the colour its tone means.
       *
       * The tiles were four identical grey boxes whose only difference was a
       * fill behind the value on a warn or a bad, which is invisible until
       * something is already wrong. The rail carries the meaning instead —
       * green where a figure is good, amber where it wants watching, brand
       * where it is just the ordinary measure — and it is the one piece of
       * colour on the tile, so it is the piece that gets noticed.
       */
      const rail = k.tone ? TONE_INK[k.tone] : PAPER.brand
      const railed = (r: number) => {
        ws.getCell(r, c1).border = { left: { style: 'medium', color: { argb: rail } } }
      }

      ws.mergeCells(tileRow, c1, tileRow, c2)
      const label = ws.getCell(tileRow, c1)
      label.value = k.label
      label.font = { name: 'Calibri', size: 9, bold: true, color: { argb: INK.muted } }
      label.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PAPER.card } }
      label.alignment = { vertical: 'middle', indent: 1 }
      railed(tileRow)

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
      railed(tileRow + 1)
      ws.getRow(tileRow + 1).height = 24

      // The denominator, always. A figure without one invites the reader to
      // supply their own.
      ws.mergeCells(tileRow + 2, c1, tileRow + 2, c2)
      const basis = ws.getCell(tileRow + 2, c1)
      basis.value = k.basis
      basis.font = { name: 'Calibri', size: 8, color: { argb: INK.muted } }
      basis.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PAPER.card } }
      basis.alignment = { vertical: 'top', indent: 1, wrapText: true }
      railed(tileRow + 2)
    })
    row += Math.ceil(analysis.kpis.length / 4) * 4 + 1
  }

  /*
   * ── Needs attention ───────────────────────────────────────────────────
   *
   * Above the charts, because a reader who looks at nothing else should still
   * see these. A KPI is the position; this is the list of things somebody has
   * to decide about, and mixing the two makes the reader sort them every time.
   *
   * Only lines with something in them. A block of noughts teaches the reader
   * that the block is decorative, and then the one month it is not, they skip
   * it anyway.
   */
  const exceptions = (analysis.exceptions ?? []).filter((e) => e.value != null && e.value !== 0)
  if (exceptions.length) {
    sectionRule(ws, row, 'Needs attention')
    row += 1
    exceptions.forEach((e) => {
      const paper = e.tone === 'bad' ? PAPER.bad : PAPER.warn
      ws.mergeCells(row, 1, row, 4)
      const label = ws.getCell(row, 1)
      label.value = e.label
      label.font = { name: 'Calibri', size: 10, bold: true, color: { argb: TONE_INK[e.tone] } }
      label.alignment = { vertical: 'middle', indent: 1 }

      ws.mergeCells(row, 5, row, 6)
      const value = ws.getCell(row, 5)
      value.value = e.value
      value.numFmt =
        e.format === 'money'
          ? FMT.moneySigned
          : e.format === 'percent'
            ? FMT.percent
            : e.format === 'qty'
              ? FMT.qty
              : FMT.integer
      value.font = { name: 'Calibri', size: 11, bold: true, color: { argb: TONE_INK[e.tone] } }
      value.alignment = { horizontal: 'right', vertical: 'middle' }

      ws.mergeCells(row, 7, row, GRID)
      const basis = ws.getCell(row, 7)
      basis.value = e.basis
      basis.font = { name: 'Calibri', size: 9, color: { argb: TONE_INK[e.tone] } }
      basis.alignment = { vertical: 'middle', indent: 1 }

      for (let c = 1; c <= GRID; c++) {
        ws.getCell(row, c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: paper } }
      }
      ws.getRow(row).height = 18
      row += 1
    })
    row += 1
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
  // Split once, above, so the thin-data line can say which of the two the
  // reader is about to get.
  const usable = panelsUsable
  const cards = usable.filter(isCard)
  const charts = usable.filter((p) => !isCard(p))

  if (charts.length) {
    sectionRule(ws, row, 'Analysis')
    row += 1

    charts.forEach((p, i) => {
      const left = i % 2 === 0
      /** The last panel of an odd set — nothing will sit beside it. */
      const alone = left && i === charts.length - 1
      const anchorRow = row + Math.floor(i / 2) * (CHART_ROWS + 1)
      const kind = shapeFor(p)
      const money = p.format === 'money'
      const scale = (v: number | null) => (v == null ? null : money ? toLakh(v) : v)
      const labels = p.points.map((pt) => pt.label)

      /*
       * What colour each bar takes.
       *
       * One series is one colour. Shading a ranking of supplier names darker
       * where the bar is longer encodes the bar's length twice — once as
       * length, once as hue — and spends the only channel left on something
       * the reader can already see. Suppliers have no order; the ramp says
       * they do.
       *
       * The ramp belongs to categories that really are ordered: an ageing
       * band, a funnel stage. There the oldest or last is heaviest, which is
       * information the length alone does not carry.
       *
       * Red stays reserved for the points the report marked as exceptions.
       * A doughnut's slices are categories that must be told apart, and its
       * own builder already shades them — nothing to override there.
       */
      const ordered = p.question === 'ageing'
      const shades = CHART_COLOURS.rankShades
      const pointColours =
        kind === 'doughnut'
          ? undefined
          : p.points.map((pt, n) => {
              // What the point MEANS wins over everything else.
              if (pt.exception) return CHART_COLOURS.tone.bad
              if (pt.tone) return CHART_COLOURS.tone[pt.tone]
              // An ageing band is ordered and nothing else about it is known,
              // so it wears the ramp: light for the newest, dark for the
              // oldest. That is information the bar's length does not carry.
              if (!ordered) return CHART_COLOURS.primary
              const step = Math.round(
                (n / Math.max(1, p.points.length - 1)) * (shades.length - 1)
              )
              return shades[shades.length - 1 - step]
            })

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
          // Meaning first — paid against outstanding is green against amber
          // wherever it appears. Only a split whose parts carry no meaning of
          // their own falls back to the categorical three, and those are three
          // hues rather than three steps of one teal because adjacent segments
          // of a stack are the hardest pair in any chart to tell apart.
          colour: s.tone
            ? CHART_COLOURS.tone[s.tone]
            : CHART_COLOURS.series[n % CHART_COLOURS.series.length],
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
        /*
         * Two across, except a last chart with nothing beside it.
         *
         * An odd number of panels used to leave the final one at half width
         * with an empty half-page next to it, which reads as a chart that
         * failed to draw. Alone on its row it takes the whole width instead —
         * and a ranking of suppliers is the better for it, since the names
         * are what get truncated first.
         */
        anchor: {
          fromCol: alone || left ? 0 : GRID / 2,
          fromRow: anchorRow - 1,
          toCol: alone ? GRID : left ? GRID / 2 : GRID,
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
        // The note sits under its own chart, so it widens with it.
        const c1 = alone || left ? 1 : GRID / 2 + 1
        ws.mergeCells(noteRow, c1, noteRow, alone || !left ? GRID : GRID / 2)
        const n = ws.getCell(noteRow, c1)
        n.value = p.note
        n.font = { name: 'Calibri', size: 8, italic: true, color: { argb: INK.muted } }
        n.alignment = { wrapText: true, vertical: 'top' }
      }
    })
    row += Math.ceil(charts.length / 2) * (CHART_ROWS + 1) + 1
  }

  /*
   * A single category is a figure, not a chart.
   *
   * One bar against an axis is a number wearing a chart's costume: it takes
   * fifteen rows to say what a tile says in three, and on a young period —
   * one supplier, one status — a whole screen of them reads as a dashboard
   * that has failed rather than a business with one supplier.
   *
   * They are laid out as the KPI band is, four across, because that is what
   * they are. A panel with no points at all says so in words: an empty chart
   * frame is indistinguishable from a broken one.
   */
  if (cards.length) {
    sectionRule(ws, row, 'Single figures')
    row += 1
    const PER = 3
    cards.forEach((p, i) => {
      const tileRow = row + Math.floor(i / 4) * 4
      const c1 = 1 + (i % 4) * PER
      const c2 = c1 + PER - 1
      const pt = p.points[0]
      const paint = (r: number, fill: string) => {
        ws.mergeCells(r, c1, r, c2)
        const cell = ws.getCell(r, c1)
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } }
        cell.alignment = { vertical: 'middle', indent: 1, wrapText: true }
        return cell
      }

      const label = paint(tileRow, PAPER.card)
      label.value = p.title
      label.font = { name: 'Calibri', size: 9, bold: true, color: { argb: INK.muted } }

      const value = paint(tileRow + 1, PAPER.card)
      if (pt) {
        value.value = pt.value
        value.numFmt =
          p.format === 'money' ? FMT.money : p.format === 'percent' ? FMT.percent : FMT.integer
        value.font = { name: 'Calibri', size: 16, bold: true, color: { argb: INK.heading } }
      } else {
        value.value = 'No data for this period'
        value.font = { name: 'Calibri', size: 10, italic: true, color: { argb: INK.muted } }
      }
      ws.getRow(tileRow + 1).height = 24

      const basis = paint(tileRow + 2, PAPER.card)
      basis.value = pt ? pt.label : ''
      basis.font = { name: 'Calibri', size: 8, color: { argb: INK.muted } }
      basis.alignment = { vertical: 'top', indent: 1, wrapText: true }
    })
    row += Math.ceil(cards.length / 4) * 4 + 1
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

  /*
   * ── The management table ──────────────────────────────────────────────
   *
   * The biggest few, not the first few. A register sorted by date opens on
   * its oldest rows, which are rarely the ones worth a page. Every row is
   * still on the Data sheet, and the caption says so — an extract that does
   * not admit it is an extract is how somebody totals twelve rows and
   * believes it.
   */
  if (def.summary && rows.length) {
    const spec = def.summary
    const cols = spec.columns
      .map((key) => def.columns.find((c) => c.key === key))
      .filter((c): c is NonNullable<typeof c> => Boolean(c))
    const by = def.columns.find((c) => c.key === spec.by)

    /*
     * A key that matches no column used to be dropped here without a word,
     * which is how a one-letter typo in a report's summary spec prints a
     * table quietly missing a column — the sheet looks deliberate and the
     * figure it was meant to carry is simply absent. `buildPivot` has warned
     * about this since it was written; this did not.
     */
    const unknown = spec.columns.filter((key) => !def.columns.some((c) => c.key === key))
    if (unknown.length) {
      console.warn(
        `[reports] ${def.id}: summary asks for ${unknown.map((k) => `"${k}"`).join(', ')}, which ${unknown.length === 1 ? 'is not a column' : 'are not columns'} — left out of the table`
      )
    }
    if (!by) {
      console.warn(
        `[reports] ${def.id}: no summary table — nothing is keyed "${spec.by}" to sort it by`
      )
    }

    if (cols.length && by) {
      const limit = spec.limit ?? 12
      const picked = [...rows]
        .sort((a, b) => Number(b[spec.by] ?? 0) - Number(a[spec.by] ?? 0))
        .slice(0, limit)

      sectionRule(ws, row, spec.title)
      row += 1

      // Header. Figures right, words left — the same way round as the Data
      // sheet, so the two do not read as different tables.
      const isNumeric = (t: string) =>
        t === 'money' || t === 'qty' || t === 'integer' || t === 'percent'
      cols.forEach((c, i) => {
        const cell = ws.getCell(row, 1 + i)
        cell.value = c.label
        cell.font = { name: 'Calibri', size: 9, bold: true, color: { argb: INK.onBrand } }
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PAPER.header } }
        cell.alignment = { vertical: 'middle', horizontal: isNumeric(c.type) ? 'right' : 'left' }
      })
      row += 1

      picked.forEach((r, n) => {
        cols.forEach((c, i) => {
          const cell = ws.getCell(row, 1 + i)
          cell.value = plainCell(c, r[c.key])
          const fmt = formatFor(c)
          if (fmt) cell.numFmt = fmt
          cell.font = { name: 'Calibri', size: 10, color: { argb: INK.body } }
          cell.alignment = { horizontal: isNumeric(c.type) ? 'right' : 'left' }
          const tone = c.type === 'badge' ? c.badgeTones?.[String(r[c.key])] : undefined
          if (tone) {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BADGE_PAPER[tone] } }
            cell.font = { name: 'Calibri', size: 10, bold: true, color: { argb: BADGE_INK[tone] } }
            cell.alignment = { horizontal: 'center' }
          } else if (n % 2 === 1) {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PAPER.card } }
          }
        })
        row += 1
      })

      ws.mergeCells(row, 1, row, GRID)
      const caption = ws.getCell(row, 1)
      caption.value =
        picked.length < rows.length
          ? `The ${picked.length} biggest by ${by.label.toLowerCase()}. All ${rows.length.toLocaleString('en-IN')} rows are on the Data sheet.`
          : `All ${rows.length.toLocaleString('en-IN')} ${rows.length === 1 ? 'row' : 'rows'}, biggest by ${by.label.toLowerCase()} first.`
      caption.font = { name: 'Calibri', size: 8, italic: true, color: { argb: INK.muted } }
      row += 2
    }
  }

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
