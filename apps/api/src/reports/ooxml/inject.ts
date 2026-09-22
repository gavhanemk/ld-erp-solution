import JSZip from 'jszip'
import { chartPartXml, type ChartSpec } from './chart-xml'

/**
 * Puts native charts into a finished .xlsx.
 *
 * An .xlsx is a ZIP of XML parts and a chart is four of them, so with no chart
 * API in ExcelJS the way through is to build the workbook normally, serialise
 * it, and then open *that* zip and add parts. Nothing in here writes a cell —
 * a post-processing step that rewrote values is exactly how a total ends up
 * disagreeing between the Data sheet and the Dashboard.
 */

const CHART_CT = 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml'
const DRAWING_CT = 'application/vnd.openxmlformats-officedocument.drawing+xml'
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

/** Which sheetN.xml holds the named worksheet. */
async function findSheetPath(zip: JSZip, sheetName: string): Promise<string> {
  const wbXml = await zip.file('xl/workbook.xml')!.async('string')
  const relsXml = await zip.file('xl/_rels/workbook.xml.rels')!.async('string')

  const sheetTag = [...wbXml.matchAll(/<sheet\b[^>]*\/>/g)]
    .map((m) => m[0])
    .find((t) => {
      const name = /name="([^"]*)"/.exec(t)?.[1]
      return name === sheetName
    })
  if (!sheetTag) throw new Error(`No sheet named ${sheetName} in the workbook`)

  const rId = /r:id="([^"]+)"/.exec(sheetTag)?.[1]
  if (!rId) throw new Error(`Sheet ${sheetName} has no relationship id`)

  const target = new RegExp(`Id="${rId}"[^>]*Target="([^"]+)"`).exec(relsXml)?.[1]
  if (!target) throw new Error(`Relationship ${rId} points nowhere`)

  return `xl/${target.replace(/^\/?xl\//, '').replace(/^\//, '')}`
}

export async function injectCharts(
  xlsx: Buffer,
  sheetName: string,
  specs: ChartSpec[]
): Promise<Buffer> {
  if (specs.length === 0) return xlsx

  const zip = await JSZip.loadAsync(xlsx)
  const sheetPath = await findSheetPath(zip, sheetName)
  const sheetFile = sheetPath.replace(/^xl\//, '')
  const sheetRelsPath = `xl/${sheetFile.replace(/([^/]+)$/, '_rels/$1.rels')}`

  // ── 1. Chart parts ────────────────────────────────────────────────────
  const firstChart = nextFreeNumber(zip, 'charts', 'chart')
  const chartNumbers = specs.map((_, i) => firstChart + i)
  specs.forEach((spec, i) => {
    zip.file(`xl/charts/chart${chartNumbers[i]}.xml`, chartPartXml(spec))
  })

  // ── 2. The drawing, and its rels pointing at each chart ───────────────
  const drawingNumber = nextFreeNumber(zip, 'drawings', 'drawing')
  const drawingRIds = specs.map((_, i) => `rId${i + 1}`)
  zip.file(`xl/drawings/drawing${drawingNumber}.xml`, drawingPartXml(specs, drawingRIds))
  zip.file(
    `xl/drawings/_rels/drawing${drawingNumber}.xml.rels`,
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' +
      `<Relationships xmlns="${PACKAGE_REL_NS}">` +
      specs
        .map(
          (_, i) =>
            `<Relationship Id="${drawingRIds[i]}" Type="${REL_NS}/chart" Target="../charts/chart${chartNumbers[i]}.xml"/>`
        )
        .join('') +
      '</Relationships>'
  )

  // ── 3. Point the sheet at the drawing ─────────────────────────────────
  //
  // The rels file already holds hyperlink relationships, so the id is taken
  // from the highest that exists rather than assumed — a collision silently
  // repoints somebody's link at a chart.
  const existingRels = zip.file(sheetRelsPath)
  const relsXml = existingRels
    ? await existingRels.async('string')
    : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<Relationships xmlns="${PACKAGE_REL_NS}"></Relationships>`

  const drawingRId = `rId${nextFreeRelId(relsXml)}`
  zip.file(
    sheetRelsPath,
    relsXml.replace(
      '</Relationships>',
      `<Relationship Id="${drawingRId}" Type="${REL_NS}/drawing" Target="../drawings/drawing${drawingNumber}.xml"/></Relationships>`
    )
  )

  // ── 4. The <drawing/> tag, near the END of the worksheet part ─────────
  //
  // It belongs after pageSetup and before tableParts / extLst / legacyDrawing.
  // At the top of the worksheet the sheet is rejected outright.
  let sheetXml = await zip.file(sheetPath)!.async('string')
  const drawingTag = `<drawing r:id="${drawingRId}"/>`
  const before = ['<tableParts', '<extLst', '<legacyDrawing'].find((t) => sheetXml.includes(t))
  sheetXml = before
    ? sheetXml.replace(before, `${drawingTag}${before}`)
    : sheetXml.replace('</worksheet>', `${drawingTag}</worksheet>`)

  // The worksheet must declare the relationships namespace to carry r:id.
  if (!/xmlns:r=/.test(sheetXml)) {
    sheetXml = sheetXml.replace('<worksheet ', `<worksheet xmlns:r="${REL_NS}" `)
  }
  zip.file(sheetPath, sheetXml)

  // ── 5. Content types. Omit these and Excel refuses the file with no clue
  //      which part is at fault.
  let ct = await zip.file('[Content_Types].xml')!.async('string')
  const overrides =
    chartNumbers
      .map((n) => `<Override PartName="/xl/charts/chart${n}.xml" ContentType="${CHART_CT}"/>`)
      .join('') +
    `<Override PartName="/xl/drawings/drawing${drawingNumber}.xml" ContentType="${DRAWING_CT}"/>`
  ct = ct.replace('</Types>', `${overrides}</Types>`)
  zip.file('[Content_Types].xml', ct)

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}
