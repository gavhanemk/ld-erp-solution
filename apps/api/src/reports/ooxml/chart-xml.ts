/**
 * Chart parts, written by hand.
 *
 * ExcelJS has no chart API and never has — `wb.addChart` is undefined, and
 * `ws.addImage` is the only drawing it knows. So a native chart has to be an
 * OOXML part written into the finished zip.
 *
 * Everything in here is about child order. There is no partial failure in
 * Excel and no useful error: one element in the wrong place and the whole
 * workbook opens as "we found a problem with some content" naming nothing,
 * after which Excel *repairs* the file by deleting the drawing — so it opens
 * looking merely empty rather than looking broken. Nothing is appended "while
 * we are here".
 */

/** The eight colours a chart may use, and what each one means. */
export const CHART_COLOURS = {
  /** The one brand hue. Every ordinary series is this. */
  primary: '0F766E',
  /**
   * The ordinal ramp, dark to light.
   *
   * For categories that genuinely have an order — an ageing band, a funnel
   * stage — and nothing else. Shading a ranking of supplier names by rank
   * double-encodes the bar's own length as colour and spends the only free
   * channel on something the length has already said.
   */
  rankShades: ['134E4A', '0F766E', '14918A', '2FB3A8', '7FD1C7'],
  /**
   * Stacked segments, which are categories and must be told apart.
   *
   * Three hues rather than three steps of teal: a single-hue ramp used
   * categorically is exactly the case where two adjacent segments become one
   * segment to a colour-blind reader. Checked against a white sheet for the
   * lightness band, the chroma floor, colour-blind separation and contrast.
   */
  series: ['0D9488', 'EB6834', '4A3AA7'],
  /** Reserved. Nothing is red unless it is an exception. */
  exception: 'B91C1C',
  /** Good and watch, for status only. */
  good: '15803D',
  warn: 'B45309',
  /** Comparison series two — a neutral grey, so the eye reads the primary. */
  compare: '94A3B8',
  axis: '64748B',
  grid: 'E2E8F0',
} as const

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** A sheet name inside a formula. Quoted, because ours has a space in it. */
export function sheetRef(sheet: string, a1: string): string {
  const needsQuotes = /[^A-Za-z0-9_]/.test(sheet)
  return `${needsQuotes ? `'${sheet.replace(/'/g, "''")}'` : sheet}!${a1}`
}

export type ChartKind =
  | 'bar'
  | 'column'
  | 'line'
  | 'doughnut'
  /** Segments summed into one bar per category, rather than side by side. */
  | 'stackedBar'
  | 'stackedColumn'
  /**
   * Columns biggest-first with the running share on a second axis.
   *
   * The one chart here that answers a question a table cannot: not "who is
   * biggest" but "how few of them make up the most of it". Series one is the
   * value, series two the cumulative percentage.
   */
  | 'pareto'

export interface ChartSeries {
  name: string
  /** Where the numbers live, as a full sheet reference. */
  valuesRef: string
  /** The values themselves, cached into the part. */
  values: Array<number | null>
  /** Solid colour for the whole series, or one per point for a ranking. */
  colour?: string
  pointColours?: string[]
}

export interface ChartSpec {
  kind: ChartKind
  title: string
  /** Where the labels live, as a full sheet reference. */
  categoriesRef: string
  categories: string[]
  series: ChartSeries[]
  /** Excel number format for the value axis and the labels. */
  numFmt: string
  /** Where on the Dashboard it sits. Anchored from cell to cell. */
  anchor: { fromCol: number; fromRow: number; toCol: number; toRow: number }
  showLegend: boolean
  /**
   * Drops the number printed on each bar.
   *
   * For a stack of three or more segments, where the labels collide with each
   * other and with the segment boundaries — and a number you cannot read is
   * worse than no number, because it still takes the space.
   */
  hideLabels?: boolean
}

// ── Small shared pieces ─────────────────────────────────────────────────────

const solidFill = (hex: string) => `<a:solidFill><a:srgbClr val="${hex}"/></a:solidFill>`

const textProps = (sizeHundredths: number, hex: string, bold = false) =>
  `<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="${sizeHundredths}" b="${bold ? 1 : 0}">` +
  `${solidFill(hex)}<a:latin typeface="Calibri"/></a:defRPr></a:pPr><a:endParaRPr lang="en-IN"/></a:p></c:txPr>`

/**
 * The category axis cache.
 *
 * Both the reference and the copied strings. The reference is what keeps the
 * chart live and editable; the cache is what lets Excel draw it before it has
 * recalculated, and what makes it survive the source sheet being hidden.
 */
function catRef(ref: string, labels: string[]): string {
  const pts = labels.map((l, i) => `<c:pt idx="${i}"><c:v>${esc(l)}</c:v></c:pt>`).join('')
  return (
    `<c:cat><c:strRef><c:f>${esc(ref)}</c:f><c:strCache>` +
    `<c:ptCount val="${labels.length}"/>${pts}` +
    `</c:strCache></c:strRef></c:cat>`
  )
}

function valRef(ref: string, values: Array<number | null>, numFmt: string): string {
  // A null is omitted rather than written as nought. A gap in a line is an
  // absence; a nought is a claim that nothing happened.
  const pts = values
    .map((v, i) => (v == null ? '' : `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`))
    .join('')
  return (
    `<c:val><c:numRef><c:f>${esc(ref)}</c:f><c:numCache>` +
    `<c:formatCode>${esc(numFmt)}</c:formatCode><c:ptCount val="${values.length}"/>${pts}` +
    `</c:numCache></c:numRef></c:val>`
  )
}

/**
 * A series name that is a literal, not a cell.
 *
 * Written as `c:tx/c:v` rather than as a `c:strRef` with an empty `c:f`.
 * `ST_Formula` has no empty member, so `<c:f></c:f>` is invalid — and Excel
 * answers an invalid chart part by repairing the workbook, which means
 * deleting the drawing and opening the file looking merely empty. It refused
 * to open at all here, which was the luckier of the two outcomes.
 */
const seriesName = (name: string) => `<c:tx><c:v>${esc(name)}</c:v></c:tx>`

/** Per-point colours, for a ranking shaded by rank or a marked exception. */
function dataPoints(colours: string[] | undefined, kind: ChartKind): string {
  if (!colours?.length) return ''
  return colours
    .map(
      (hex, i) =>
        `<c:dPt><c:idx val="${i}"/>` +
        (kind === 'doughnut' ? '' : '<c:invertIfNegative val="0"/>') +
        `<c:bubble3D val="0"/><c:spPr>${solidFill(hex)}</c:spPr></c:dPt>`
    )
    .join('')
}

/**
 * Data labels.
 *
 * `c:dLblPos` is deliberately never written. A pie accepts `bestFit`; a
 * doughnut accepts no position element at all, and one shared builder that
 * emitted it for both had five of six workbooks refused — the tell being that
 * the only report with no doughnut opened perfectly. Omitting it everywhere
 * costs a little default placement and removes the whole class of bug.
 *
 * Child order is numFmt, spPr, txPr, dLblPos, showLegendKey, showVal,
 * showCatName, showSerName, showPercent, showBubbleSize, separator.
 */
function dataLabels(opts: { numFmt?: string; percent?: boolean }): string {
  return (
    '<c:dLbls>' +
    (opts.numFmt ? `<c:numFmt formatCode="${esc(opts.numFmt)}" sourceLinked="0"/>` : '') +
    '<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr>' +
    textProps(900, '334155') +
    '<c:showLegendKey val="0"/>' +
    `<c:showVal val="${opts.percent ? 0 : 1}"/>` +
    '<c:showCatName val="0"/><c:showSerName val="0"/>' +
    `<c:showPercent val="${opts.percent ? 1 : 0}"/>` +
    '<c:showBubbleSize val="0"/>' +
    '</c:dLbls>'
  )
}

// ── Series builders, one per chart family ───────────────────────────────────
//
// Three, not one with flags: `c:ser` orders its children differently for bar,
// line and pie, and a shared builder is how the doughnut trap got in.

/** bar/column: idx, order, tx, spPr, invertIfNegative, dPt, dLbls, cat, val */
function barSeries(s: ChartSeries, i: number, spec: ChartSpec): string {
  return (
    `<c:ser><c:idx val="${i}"/><c:order val="${i}"/>${seriesName(s.name)}` +
    `<c:spPr>${solidFill(s.colour ?? CHART_COLOURS.primary)}</c:spPr>` +
    '<c:invertIfNegative val="0"/>' +
    dataPoints(s.pointColours, spec.kind) +
    (spec.hideLabels ? '' : dataLabels({ numFmt: spec.numFmt })) +
    catRef(spec.categoriesRef, spec.categories) +
    valRef(s.valuesRef, s.values, spec.numFmt) +
    '</c:ser>'
  )
}

/** line: idx, order, tx, spPr, marker, dPt, dLbls, cat, val, smooth */
function lineSeries(s: ChartSeries, i: number, spec: ChartSpec): string {
  const hex = s.colour ?? CHART_COLOURS.primary
  return (
    `<c:ser><c:idx val="${i}"/><c:order val="${i}"/>${seriesName(s.name)}` +
    `<c:spPr><a:ln w="22225" cap="rnd">${solidFill(hex)}<a:round/></a:ln><a:effectLst/></c:spPr>` +
    `<c:marker><c:symbol val="circle"/><c:size val="5"/>` +
    `<c:spPr>${solidFill(hex)}<a:ln w="9525">${solidFill('FFFFFF')}</a:ln></c:spPr></c:marker>` +
    catRef(spec.categoriesRef, spec.categories) +
    valRef(s.valuesRef, s.values, spec.numFmt) +
    '<c:smooth val="0"/>' +
    '</c:ser>'
  )
}

/** pie/doughnut: idx, order, tx, spPr, explosion, dPt, dLbls, cat, val */
function pieSeries(s: ChartSeries, i: number, spec: ChartSpec): string {
  const shades = s.pointColours ?? spec.categories.map((_, n) => CHART_COLOURS.rankShades[n % 5])
  return (
    `<c:ser><c:idx val="${i}"/><c:order val="${i}"/>${seriesName(s.name)}` +
    dataPoints(shades, 'doughnut') +
    dataLabels({ percent: true }) +
    catRef(spec.categoriesRef, spec.categories) +
    valRef(s.valuesRef, s.values, spec.numFmt) +
    '</c:ser>'
  )
}

// ── Axes ────────────────────────────────────────────────────────────────────

const CAT_AX = 111111111
const VAL_AX = 222222222
/**
 * The second pair, for the running-share line on a Pareto.
 *
 * A combo chart is two plot groups in one plotArea, and each group names its
 * own axis pair. Sharing one pair between them puts a percentage that tops out
 * at 100 on the same scale as rupees in lakhs, which flattens the line onto
 * the floor — it draws, it is just useless, which is the worst of the three
 * outcomes because nothing reports it.
 */
const CAT_AX2 = 333333333
const VAL_AX2 = 444444444

/**
 * catAx: axId, scaling, delete, axPos, majorGridlines, title, numFmt,
 * majorTickMark, minorTickMark, tickLblPos, spPr, txPr, crossAx, crosses,
 * auto, lblAlgn, lblOffset, noMultiLvlLbl
 */
function categoryAxis(
  pos: 'b' | 'l',
  reverse: boolean,
  opts: { id?: number; crossId?: number; deleted?: boolean } = {}
): string {
  const { id = CAT_AX, crossId = VAL_AX, deleted = false } = opts
  return (
    `<c:catAx><c:axId val="${id}"/>` +
    `<c:scaling><c:orientation val="${reverse ? 'maxMin' : 'minMax'}"/></c:scaling>` +
    // A combo's second category axis is deleted, not omitted: the line group
    // must still name a pair, and drawing both pairs prints the labels twice.
    `<c:delete val="${deleted ? 1 : 0}"/><c:axPos val="${pos}"/>` +
    '<c:numFmt formatCode="General" sourceLinked="0"/>' +
    '<c:majorTickMark val="none"/><c:minorTickMark val="none"/>' +
    `<c:tickLblPos val="${deleted ? 'none' : 'nextTo'}"/>` +
    `<c:spPr><a:ln w="9525">${solidFill(CHART_COLOURS.grid)}</a:ln></c:spPr>` +
    textProps(900, CHART_COLOURS.axis) +
    `<c:crossAx val="${crossId}"/><c:crosses val="autoZero"/>` +
    '<c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/>' +
    '</c:catAx>'
  )
}

/**
 * valAx: axId, scaling, delete, axPos, majorGridlines, title, numFmt,
 * majorTickMark, minorTickMark, tickLblPos, spPr, txPr, crossAx, crosses,
 * crossBetween
 */
function valueAxis(
  pos: 'l' | 'b' | 'r',
  numFmt: string,
  opts: { id?: number; crossId?: number; crosses?: 'autoZero' | 'max'; gridlines?: boolean } = {}
): string {
  const { id = VAL_AX, crossId = CAT_AX, crosses = 'autoZero', gridlines = true } = opts
  return (
    `<c:valAx><c:axId val="${id}"/>` +
    '<c:scaling><c:orientation val="minMax"/></c:scaling>' +
    `<c:delete val="0"/><c:axPos val="${pos}"/>` +
    // Only one of a combo's two value axes draws gridlines. Two sets at
    // different intervals is a grid nobody can read a value off.
    (gridlines
      ? `<c:majorGridlines><c:spPr><a:ln w="9525">${solidFill(CHART_COLOURS.grid)}</a:ln></c:spPr></c:majorGridlines>`
      : '') +
    `<c:numFmt formatCode="${esc(numFmt)}" sourceLinked="0"/>` +
    '<c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/>' +
    '<c:spPr><a:ln><a:noFill/></a:ln></c:spPr>' +
    textProps(900, CHART_COLOURS.axis) +
    `<c:crossAx val="${crossId}"/><c:crosses val="${crosses}"/><c:crossBetween val="between"/>` +
    '</c:valAx>'
  )
}

// ── The plot ────────────────────────────────────────────────────────────────

/** barChart: barDir, grouping, varyColors, ser…, dLbls, gapWidth, overlap, axId, axId */
function barPlot(spec: ChartSpec): string {
  const horizontal = spec.kind === 'bar' || spec.kind === 'stackedBar'
  const stacked = spec.kind === 'stackedBar' || spec.kind === 'stackedColumn'
  const many = spec.series.length > 1
  return (
    '<c:barChart>' +
    `<c:barDir val="${horizontal ? 'bar' : 'col'}"/>` +
    `<c:grouping val="${stacked ? 'stacked' : 'clustered'}"/><c:varyColors val="0"/>` +
    spec.series.map((s, i) => barSeries(s, i, spec)).join('') +
    `<c:gapWidth val="${many && !stacked ? 80 : 45}"/>` +
    // Stacked segments must sit exactly on top of each other. Anything short
    // of 100 leaves them offset, which reads as a clustered chart drawn wrong
    // rather than as a stack.
    `<c:overlap val="${stacked ? 100 : many ? -20 : 0}"/>` +
    `<c:axId val="${CAT_AX}"/><c:axId val="${VAL_AX}"/>` +
    '</c:barChart>' +
    // A horizontal bar reads top-down, so its category axis runs maxMin —
    // otherwise the biggest bar lands at the bottom and a ranking reads
    // backwards.
    categoryAxis(horizontal ? 'l' : 'b', horizontal) +
    valueAxis(horizontal ? 'b' : 'l', spec.numFmt)
  )
}

/**
 * Columns plus the running share, on two axis pairs.
 *
 * Two plot groups in one plotArea. Every group element comes first and every
 * axis after — interleaving them is schema-invalid, and the way Excel reports
 * that is by repairing the workbook into one with no chart in it.
 *
 * The second category axis is deleted rather than left out: the line group has
 * to name an axis pair, and a drawn second axis prints the labels twice.
 */
function paretoPlot(spec: ChartSpec): string {
  const [value, cumulative] = spec.series
  return (
    '<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="0"/>' +
    barSeries(value, 0, spec) +
    '<c:gapWidth val="45"/><c:overlap val="0"/>' +
    `<c:axId val="${CAT_AX}"/><c:axId val="${VAL_AX}"/>` +
    '</c:barChart>' +
    '<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>' +
    lineSeries({ ...cumulative, colour: CHART_COLOURS.exception }, 1, {
      ...spec,
      // The share line is a percentage whatever the bars are counted in.
      numFmt: '0%',
    }) +
    '<c:marker val="1"/>' +
    `<c:axId val="${CAT_AX2}"/><c:axId val="${VAL_AX2}"/>` +
    '</c:lineChart>' +
    categoryAxis('b', false) +
    valueAxis('l', spec.numFmt) +
    valueAxis('r', '0%', {
      id: VAL_AX2,
      crossId: CAT_AX2,
      crosses: 'max',
      gridlines: false,
    }) +
    categoryAxis('b', false, { id: CAT_AX2, crossId: VAL_AX2, deleted: true })
  )
}

/** lineChart: grouping, varyColors, ser…, dLbls, dropLines, marker, axId, axId */
function linePlot(spec: ChartSpec): string {
  return (
    '<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>' +
    spec.series.map((s, i) => lineSeries(s, i, spec)).join('') +
    '<c:marker val="1"/>' +
    `<c:axId val="${CAT_AX}"/><c:axId val="${VAL_AX}"/>` +
    '</c:lineChart>' +
    categoryAxis('b', false) +
    valueAxis('l', spec.numFmt)
  )
}

/** doughnutChart: varyColors, ser…, dLbls, firstSliceAng, holeSize. No axes. */
function doughnutPlot(spec: ChartSpec): string {
  return (
    '<c:doughnutChart><c:varyColors val="1"/>' +
    spec.series.map((s, i) => pieSeries(s, i, spec)).join('') +
    '<c:firstSliceAng val="0"/><c:holeSize val="55"/>' +
    '</c:doughnutChart>'
  )
}

/**
 * One whole chart part.
 *
 * chartSpace children: date1904, lang, roundedCorners, style, clrMapOvr,
 * pivotSource, protection, chart, spPr, txPr, externalData.
 * c:chart children: title, autoTitleDeleted, view3D, floor, sideWall,
 * backWall, plotArea, legend, plotVisOnly, dispBlanksAs.
 */
export function chartPartXml(spec: ChartSpec): string {
  const plot =
    spec.kind === 'line'
      ? linePlot(spec)
      : spec.kind === 'doughnut'
        ? doughnutPlot(spec)
        : spec.kind === 'pareto'
          ? paretoPlot(spec)
          : barPlot(spec)

  const title =
    '<c:title><c:tx><c:rich><a:bodyPr rot="0" spcFirstLastPara="1" vertOverflow="ellipsis" vert="horz" wrap="square" anchor="ctr" anchorCtr="1"/>' +
    '<a:lstStyle/><a:p><a:pPr><a:defRPr sz="1050" b="1">' +
    solidFill('0F172A') +
    '<a:latin typeface="Calibri"/></a:defRPr></a:pPr>' +
    `<a:r><a:rPr lang="en-IN" sz="1050" b="1"/><a:t>${esc(spec.title)}</a:t></a:r>` +
    '</a:p></c:rich></c:tx><c:overlay val="0"/>' +
    '<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr></c:title>'

  const legend = spec.showLegend
    ? `<c:legend><c:legendPos val="b"/><c:overlay val="0"/><c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr>${textProps(900, CHART_COLOURS.axis)}</c:legend>`
    : ''

  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' +
    '<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" ' +
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<c:date1904 val="0"/><c:lang val="en-IN"/><c:roundedCorners val="0"/>' +
    '<c:chart>' +
    title +
    '<c:autoTitleDeleted val="0"/>' +
    `<c:plotArea><c:layout/>${plot}<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr></c:plotArea>` +
    legend +
    '<c:plotVisOnly val="0"/>' +
    '<c:dispBlanksAs val="gap"/>' +
    '</c:chart>' +
    `<c:spPr>${solidFill('FFFFFF')}<a:ln w="9525">${solidFill(CHART_COLOURS.grid)}</a:ln></c:spPr>` +
    textProps(900, '334155') +
    '</c:chartSpace>'
  )
}
