import JSZip from 'jszip'
import { chartPartXml, type ChartSpec } from './chart-xml'
import {
  pivotCacheDefinitionXml,
  pivotCacheRecordsXml,
  pivotTableXml,
  type PivotPlan,
} from './pivot-xml'

/**
 * Puts native charts and native PivotTables into a finished .xlsx.
 *
 * An .xlsx is a ZIP of XML parts; a chart is four of them and a pivot is five.
 * ExcelJS has an API for neither, so the way through is to build the workbook
 * normally, serialise it, and then open *that* zip and add parts. Nothing in
 * here writes a cell — a post-processing step that rewrote values is exactly
 * how a total ends up disagreeing between the Data sheet and the Dashboard.
 *
 * Both jobs share one zip and one re-serialise. Doing them as two passes cost
 * a full inflate and deflate of every part in the file to save about thirty
 * lines, and the second pass had to re-find everything the first had just
 * found.
 */

const CHART_CT = 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml'
const DRAWING_CT = 'application/vnd.openxmlformats-officedocument.drawing+xml'
const SML = 'application/vnd.openxmlformats-officedocument.spreadsheetml'
const CACHE_DEF_CT = `${SML}.pivotCacheDefinition+xml`
const CACHE_REC_CT = `${SML}.pivotCacheRecords+xml`
const PIVOT_CT = `${SML}.pivotTable+xml`

/**
 * Two relationship namespaces, and they are not interchangeable.
 *
 * The `<Relationships>` root of a .rels part is in the PACKAGE namespace. The
 * `Type` attribute on each relationship, and the `r:id` attribute inside a
 * sheet or a drawing, are in the OFFICE one.
 *
 * Writing the office namespace on the root element is what refused every
 * workbook here that had a chart in it. The tell was that it only broke once
 * the *worksheet's* rels part existed: a drawing nothing pointed at was never
 * parsed, so the same wrong namespace sat in the file harmlessly. An empty
 * `<Relationships/>` at the worksheet path was refused just the same, which
 * is what proved it was the namespace and not anything a relationship said.
 */
const PACKAGE_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

const RELS_HEAD =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' +
  `<Relationships xmlns="${PACKAGE_REL_NS}">`

/**
 * A cell anchor.
 *
 * Offsets are clamped at zero. A negative `colOff` or `rowOff` is
 * schema-legal and Excel treats it as damage — which presents as the same
 * silent repair as everything else here.
 */
function anchorXml(spec: ChartSpec, rId: string, index: number): string {
  const { fromCol, fromRow, toCol, toRow } = spec.anchor
  const at = (col: number, row: number, tag: 'from' | 'to') =>
    `<xdr:${tag}><xdr:col>${Math.max(0, col)}</xdr:col><xdr:colOff>0</xdr:colOff>` +
    `<xdr:row>${Math.max(0, row)}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:${tag}>`

  return (
    '<xdr:twoCellAnchor>' +
    at(fromCol, fromRow, 'from') +
    at(toCol, toRow, 'to') +
    '<xdr:graphicFrame macro="">' +
    '<xdr:nvGraphicFramePr>' +
    `<xdr:cNvPr id="${index + 2}" name="Chart ${index + 1}"/>` +
    '<xdr:cNvGraphicFramePr/>' +
    '</xdr:nvGraphicFramePr>' +
    '<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>' +
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">' +
    `<c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="${REL_NS}" r:id="${rId}"/>` +
    '</a:graphicData></a:graphic>' +
    '</xdr:graphicFrame>' +
    '<xdr:clientData/>' +
    '</xdr:twoCellAnchor>'
  )
}

function drawingPartXml(specs: ChartSpec[], rIds: string[]): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' +
    '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" ' +
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
    specs.map((s, i) => anchorXml(s, rIds[i], i)).join('') +
    '</xdr:wsDr>'
  )
}

/**
 * The next free part number.
 *
 * Scanned, never hardcoded. `drawing1.xml` is safe only while nothing else in
 * the workbook has a drawing — and ExcelJS writes exactly that name for an
 * embedded image, so a hardcoded name would overwrite one and leave that
 * sheet pointing at a part which no longer describes it.
 */
function nextFreeNumber(zip: JSZip, folder: string, stem: string): number {
  let n = 1
  while (zip.file(`xl/${folder}/${stem}${n}.xml`)) n++
  return n
}

/** An rId nothing else in the file is already using. */
function nextFreeRelId(relsXml: string): number {
  let highest = 0
  for (const m of relsXml.matchAll(/Id="rId(\d+)"/g)) {
    highest = Math.max(highest, Number(m[1]))
  }
  return highest + 1
}

/** Reads a rels part, or an empty one if the part does not exist yet. */
async function readRels(zip: JSZip, path: string): Promise<string> {
  const f = zip.file(path)
  return f ? f.async('string') : `${RELS_HEAD}</Relationships>`
}

/** Appends one relationship and returns the id it was given. */
function addRel(relsXml: string, type: string, target: string): { xml: string; id: string } {
  const id = `rId${nextFreeRelId(relsXml)}`
  return {
    xml: relsXml.replace(
      '</Relationships>',
      `<Relationship Id="${id}" Type="${REL_NS}/${type}" Target="${target}"/></Relationships>`
    ),
    id,
  }
}

async function addContentTypes(zip: JSZip, overrides: string): Promise<void> {
  const ct = await zip.file('[Content_Types].xml')!.async('string')
  zip.file('[Content_Types].xml', ct.replace('</Types>', `${overrides}</Types>`))
}

/** Which sheetN.xml holds the named worksheet. */
async function findSheetPath(zip: JSZip, sheetName: string): Promise<string> {
  const wbXml = await zip.file('xl/workbook.xml')!.async('string')
  const relsXml = await zip.file('xl/_rels/workbook.xml.rels')!.async('string')

  const sheetTag = [...wbXml.matchAll(/<sheet\b[^>]*\/>/g)]
    .map((m) => m[0])
    .find((t) => /name="([^"]*)"/.exec(t)?.[1] === sheetName)
  if (!sheetTag) throw new Error(`No sheet named ${sheetName} in the workbook`)

  const rId = /r:id="([^"]+)"/.exec(sheetTag)?.[1]
  if (!rId) throw new Error(`Sheet ${sheetName} has no relationship id`)

  const target = new RegExp(`Id="${rId}"[^>]*Target="([^"]+)"`).exec(relsXml)?.[1]
  if (!target) throw new Error(`Relationship ${rId} points nowhere`)

  return `xl/${target.replace(/^\/?xl\//, '').replace(/^\//, '')}`
}

/** The path of a worksheet's own rels part, which may not exist yet. */
function sheetRelsPathFor(sheetPath: string): string {
  return `xl/${sheetPath.replace(/^xl\//, '').replace(/([^/]+)$/, '_rels/$1.rels')}`
}

// ── Charts ──────────────────────────────────────────────────────────────────

async function addCharts(zip: JSZip, sheetName: string, specs: ChartSpec[]): Promise<void> {
  if (specs.length === 0) return

  const sheetPath = await findSheetPath(zip, sheetName)
  const sheetRelsPath = sheetRelsPathFor(sheetPath)

  // 1 — the chart parts
  const firstChart = nextFreeNumber(zip, 'charts', 'chart')
  const chartNumbers = specs.map((_, i) => firstChart + i)
  specs.forEach((spec, i) => {
    zip.file(`xl/charts/chart${chartNumbers[i]}.xml`, chartPartXml(spec))
  })

  // 2 — the drawing, and its rels pointing at each chart
  const drawingNumber = nextFreeNumber(zip, 'drawings', 'drawing')
  const drawingRIds = specs.map((_, i) => `rId${i + 1}`)
  zip.file(`xl/drawings/drawing${drawingNumber}.xml`, drawingPartXml(specs, drawingRIds))
  zip.file(
    `xl/drawings/_rels/drawing${drawingNumber}.xml.rels`,
    RELS_HEAD +
      specs
        .map(
          (_, i) =>
            `<Relationship Id="${drawingRIds[i]}" Type="${REL_NS}/chart" Target="../charts/chart${chartNumbers[i]}.xml"/>`
        )
        .join('') +
      '</Relationships>'
  )

  // 3 — point the sheet at the drawing.
  //
  // The rels file already holds hyperlink relationships, so the id is taken
  // from the highest that exists rather than assumed — a collision silently
  // repoints somebody's link at a chart.
  const rels = addRel(
    await readRels(zip, sheetRelsPath),
    'drawing',
    `../drawings/drawing${drawingNumber}.xml`
  )
  zip.file(sheetRelsPath, rels.xml)

  // 4 — the <drawing/> tag, near the END of the worksheet part.
  //
  // It belongs after pageSetup and before tableParts / extLst / legacyDrawing.
  // At the top of the worksheet the sheet is rejected outright.
  let sheetXml = await zip.file(sheetPath)!.async('string')
  const drawingTag = `<drawing r:id="${rels.id}"/>`
  const before = ['<tableParts', '<extLst', '<legacyDrawing'].find((t) => sheetXml.includes(t))
  sheetXml = before
    ? sheetXml.replace(before, `${drawingTag}${before}`)
    : sheetXml.replace('</worksheet>', `${drawingTag}</worksheet>`)

  // The worksheet must declare the relationships namespace to carry r:id.
  if (!/xmlns:r=/.test(sheetXml)) {
    sheetXml = sheetXml.replace('<worksheet ', `<worksheet xmlns:r="${REL_NS}" `)
  }
  zip.file(sheetPath, sheetXml)

  // 5 — content types. Omit these and Excel refuses the file with no clue
  //     which part is at fault.
  await addContentTypes(
    zip,
    chartNumbers
      .map((n) => `<Override PartName="/xl/charts/chart${n}.xml" ContentType="${CHART_CT}"/>`)
      .join('') +
      `<Override PartName="/xl/drawings/drawing${drawingNumber}.xml" ContentType="${DRAWING_CT}"/>`
  )
}

// ── Pivot tables ────────────────────────────────────────────────────────────

/**
 * A cache id no other cache in this workbook is using.
 *
 * ExcelJS writes none, so in practice this starts at one — but the pivot
 * table finds its cache by this number alone, and two caches sharing one is a
 * pivot silently reading the wrong rows rather than a file that fails to open.
 */
function nextFreeCacheId(workbookXml: string): number {
  let highest = 0
  for (const m of workbookXml.matchAll(/cacheId="(\d+)"/g)) {
    highest = Math.max(highest, Number(m[1]))
  }
  return highest + 1
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/**
 * Which id the workbook's styles part gave each number format code.
 *
 * Read, never written. Every format a pivot wants is already in the file —
 * the Data sheet put it there formatting the very column the pivot totals —
 * so this only has to find it. Adding a `<numFmt>` would mean editing the
 * styles part, and every part this touches is another chance for Excel to
 * decide the workbook needs repairing.
 *
 * The built-ins are seeded because they have no `<numFmt>` entry anywhere:
 * they are implied by their id, and a lookup that missed them would fall back
 * to General on a column that asked for `#,##0`.
 */
async function numberFormatIds(zip: JSZip): Promise<Map<string, number>> {
  const ids = new Map<string, number>([
    ['General', 0],
    ['0', 1],
    ['0.00', 2],
    ['#,##0', 3],
    ['#,##0.00', 4],
    ['0%', 9],
    ['0.00%', 10],
  ])

  const styles = zip.file('xl/styles.xml')
  if (!styles) return ids

  const xml = await styles.async('string')
  for (const m of xml.matchAll(/<numFmt\b[^>]*\/>/g)) {
    const tag = m[0]
    const id = /numFmtId="(\d+)"/.exec(tag)?.[1]
    const code = /formatCode="([^"]*)"/.exec(tag)?.[1]
    // Attribute order is the writer's choice, so each is pulled out on its
    // own rather than matched as a pair in one fixed sequence.
    if (id && code != null) ids.set(unescapeXml(code), Number(id))
  }
  return ids
}

async function addPivots(zip: JSZip, plans: PivotPlan[]): Promise<void> {
  if (plans.length === 0) return

  let workbookXml = await zip.file('xl/workbook.xml')!.async('string')
  let workbookRels = await zip.file('xl/_rels/workbook.xml.rels')!.async('string')
  const formatIds = await numberFormatIds(zip)
  const overrides: string[] = []
  const caches: string[] = []

  for (const raw of plans) {
    // Each measure prints in the same format its column does on the Data
    // sheet. A measure whose format is somehow not in the file falls back to
    // General rather than to a format that would round it.
    const plan: PivotPlan = {
      ...raw,
      dataFields: raw.dataFields.map((d) => ({ ...d, numFmtId: formatIds.get(d.numFmt) ?? 0 })),
    }
    const cacheId = nextFreeCacheId(workbookXml + caches.join(''))
    const cacheN = nextFreeNumber(zip, 'pivotCache', 'pivotCacheDefinition')
    const tableN = nextFreeNumber(zip, 'pivotTables', 'pivotTable')

    // 1 — the cache: what the fields are, and the rows as the cache sees them.
    zip.file(
      `xl/pivotCache/pivotCacheDefinition${cacheN}.xml`,
      pivotCacheDefinitionXml({ ...plan, cacheId }, true)
    )
    zip.file(`xl/pivotCache/pivotCacheRecords${cacheN}.xml`, pivotCacheRecordsXml(plan))
    zip.file(
      `xl/pivotCache/_rels/pivotCacheDefinition${cacheN}.xml.rels`,
      RELS_HEAD +
        `<Relationship Id="rId1" Type="${REL_NS}/pivotCacheRecords"` +
        ` Target="pivotCacheRecords${cacheN}.xml"/>` +
        '</Relationships>'
    )

    // 2 — the table, and the rel that ties it back to its cache.
    zip.file(`xl/pivotTables/pivotTable${tableN}.xml`, pivotTableXml({ ...plan, cacheId }))
    zip.file(
      `xl/pivotTables/_rels/pivotTable${tableN}.xml.rels`,
      RELS_HEAD +
        `<Relationship Id="rId1" Type="${REL_NS}/pivotCacheDefinition"` +
        ` Target="../pivotCache/pivotCacheDefinition${cacheN}.xml"/>` +
        '</Relationships>'
    )

    // 3 — the workbook owns the cache, not the sheet.
    const wbRel = addRel(
      workbookRels,
      'pivotCacheDefinition',
      `pivotCache/pivotCacheDefinition${cacheN}.xml`
    )
    workbookRels = wbRel.xml
    caches.push(`<pivotCache cacheId="${cacheId}" r:id="${wbRel.id}"/>`)

    // 4 — the sheet owns the table, and a relationship is the whole of it.
    //     There is no <pivotTable> tag inside the worksheet part.
    const sheetPath = await findSheetPath(zip, plan.sheet)
    const sheetRelsPath = sheetRelsPathFor(sheetPath)
    const sheetRel = addRel(
      await readRels(zip, sheetRelsPath),
      'pivotTable',
      `../pivotTables/pivotTable${tableN}.xml`
    )
    zip.file(sheetRelsPath, sheetRel.xml)

    overrides.push(
      `<Override PartName="/xl/pivotCache/pivotCacheDefinition${cacheN}.xml" ContentType="${CACHE_DEF_CT}"/>`,
      `<Override PartName="/xl/pivotCache/pivotCacheRecords${cacheN}.xml" ContentType="${CACHE_REC_CT}"/>`,
      `<Override PartName="/xl/pivotTables/pivotTable${tableN}.xml" ContentType="${PIVOT_CT}"/>`
    )
  }

  // 5 — <pivotCaches> has a fixed place in the workbook's element order: after
  //     calcPr and customWorkbookViews, before extLst. Out of order and the
  //     whole workbook part fails to validate.
  const block = `<pivotCaches>${caches.join('')}</pivotCaches>`
  workbookXml = workbookXml.includes('<extLst')
    ? workbookXml.replace('<extLst', `${block}<extLst`)
    : workbookXml.replace('</workbook>', `${block}</workbook>`)

  zip.file('xl/workbook.xml', workbookXml)
  zip.file('xl/_rels/workbook.xml.rels', workbookRels)
  await addContentTypes(zip, overrides.join(''))
}

// ── The one pass ────────────────────────────────────────────────────────────

export async function injectOoxml(
  xlsx: Buffer,
  opts: { chartSheet: string; charts: ChartSpec[]; pivots: PivotPlan[] }
): Promise<Buffer> {
  if (opts.charts.length === 0 && opts.pivots.length === 0) return xlsx

  const zip = await JSZip.loadAsync(xlsx)
  await addCharts(zip, opts.chartSheet, opts.charts)
  await addPivots(zip, opts.pivots)
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}
