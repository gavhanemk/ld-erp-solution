/**
 * A native PivotTable, written as OOXML by hand.
 *
 * ExcelJS 4.4 has no pivot API — the only `pivot` in its source is a sheet
 * protection flag — so this follows the same road the charts took: build the
 * workbook normally, serialise it, then open that zip and add parts.
 *
 * A pivot is three parts and four registrations:
 *
 *   xl/pivotCache/pivotCacheDefinition{n}.xml   what the fields are
 *   xl/pivotCache/pivotCacheRecords{n}.xml      the rows, as the cache sees them
 *   xl/pivotTables/pivotTable{n}.xml            the layout
 *   + a rels file for each of the latter two
 *   + <pivotCaches> in workbook.xml, a workbook rel, a sheet rel, content types
 *
 * The cache reads the Data sheet rather than a copy of the rows, so the pivot
 * and the Data sheet cannot disagree — and `refreshOnLoad` makes Excel rebuild
 * the cache from those cells the moment the file opens, which means a stale
 * cached figure is not a failure mode this can have.
 */

/**
 * Everything under 0x20 that XML 1.0 forbids outright — which is all of them
 * but tab, newline and carriage return.
 *
 * Built from char codes rather than written as a literal class: a class of
 * unicode escapes is the one thing in this file that a patch tool or a shell
 * on the way in can quietly turn into something else, and a class that loses
 * its backslashes stops matching control characters and starts matching the
 * digits nought and eight.
 */
const ch = String.fromCharCode
const CONTROL = new RegExp(`[${ch(0)}-${ch(8)}${ch(11)}${ch(12)}${ch(14)}-${ch(31)}]`, 'g')

/** Strips those, then escapes the five characters XML reserves. */
function esc(s: string): string {
  return s
    .replace(CONTROL, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * A number as XML sees it.
 *
 * `String(1e21)` is "1e+21", which Excel's parser does not accept as a double
 * and which presents as the same silent repair as everything else here.
 * Nothing the mill bills reaches that, but a guard costing one branch is
 * cheaper than finding out it did.
 */
function num(n: number): string {
  if (!Number.isFinite(n)) return '0'
  return Math.abs(n) >= 1e21 ? n.toFixed(0) : String(n)
}

/** Excel wants a local ISO timestamp with no zone on a cached date. */
function isoLocal(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  )
}

export type PivotFieldKind = 'text' | 'number' | 'date'

export interface PivotFieldPlan {
  /** The header text on the source sheet. Must match it exactly. */
  name: string
  kind: PivotFieldKind
  /**
   * Distinct values, in cache order.
   *
   * Only a field on an axis or behind a slicer needs them. Everything else
   * carries its value inline in the records, which keeps that part to the size
   * of the data rather than the data plus an index nothing reads.
   */
  items?: string[]
  /** Whether any row is blank here, which is an item of its own to Excel. */
  blank?: boolean
  min?: number
  max?: number
}

export interface PivotDataField {
  /** Index into `fields`. */
  field: number
  label: string
  /**
   * The number format code this measure prints in — the same one the Data
   * sheet uses for that column.
   *
   * A code rather than an id, because the id is whatever position Excel's
   * styles part happens to have put the format at, and the built-in that
   * looks closest (`#,##0.00`) groups in thousands. A pack whose Data sheet
   * reads 1,42,80,000 and whose Pivot reads 14,280,000 for the same total is
   * two different numbers to everyone who opens it.
   */
  numFmt: string
  /** Resolved against the workbook's styles part at injection time. */
  numFmtId?: number
}

export interface PivotPlan {
  /** Unique across the workbook. Slicers bind to a pivot by this name. */
  tableName: string
  cacheId: number
  /** The sheet the pivot renders on. */
  sheet: string
  /** The sheet the cache reads. */
  sourceSheet: string
  /** Header row plus data rows — never the totals row. */
  sourceRef: string
  fields: PivotFieldPlan[]
  /** Index into `fields`: the one down the left. */
  rowField: number
  dataFields: PivotDataField[]
  /** Indices into `fields` that get a slicer. */
  slicerFields: number[]
  /** Top-left of the pivot on its sheet, 1-based. */
  at: { row: number; col: number }
  /**
   * One array per source row, aligned with `fields`.
   *
   * Walked once and lazily, so the cache never holds a second copy of ten
   * thousand rows alongside the one ExcelJS already has. The count is carried
   * separately because an iterable has no length to ask for.
   */
  records: Iterable<Array<string | number | Date | null>>
  recordCount: number
}

const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

export function colLetter(n: number): string {
  let s = ''
  while (n > 0) {
    const r = (n - 1) % 26
    s = String.fromCharCode(65 + r) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

/**
 * How many rows and columns the pivot occupies.
 *
 * An estimate, and deliberately so: `refreshOnLoad` has Excel recompute the
 * layout and rewrite this range on open. It only has to be a valid range that
 * overlaps nothing else, which is why the sheet holds the pivot and a heading
 * and nothing besides.
 */
export function pivotExtent(plan: PivotPlan): { rows: number; cols: number } {
  const f = plan.fields[plan.rowField]
  const items = (f?.items?.length ?? 0) + (f?.blank ? 1 : 0)
  return { rows: 1 + items + 1, cols: 1 + plan.dataFields.length }
}

export function pivotLocationRef(plan: PivotPlan): string {
  const { rows, cols } = pivotExtent(plan)
  const { row, col } = plan.at
  return `${colLetter(col)}${row}:${colLetter(col + cols - 1)}${row + rows - 1}`
}

// ── The cache definition ────────────────────────────────────────────────────

function cacheFieldXml(f: PivotFieldPlan): string {
  let shared: string

  if (f.items) {
    // `count` must equal the number of children. A mismatch is the most
    // reliable way there is to have Excel quietly repair the file.
    const count = f.items.length + (f.blank ? 1 : 0)
    shared =
      `<sharedItems${f.blank ? ' containsBlank="1"' : ''} count="${count}">` +
      f.items.map((v) => `<s v="${esc(v)}"/>`).join('') +
      (f.blank ? '<m/>' : '') +
      '</sharedItems>'
  } else if (f.kind === 'number') {
    shared =
      '<sharedItems containsSemiMixedTypes="0" containsString="0" containsNumber="1"' +
      (f.blank ? ' containsBlank="1"' : '') +
      (f.min != null ? ` minValue="${num(f.min)}"` : '') +
      (f.max != null ? ` maxValue="${num(f.max)}"` : '') +
      '/>'
  } else if (f.kind === 'date') {
    shared =
      '<sharedItems containsNonDate="0" containsDate="1" containsString="0"' +
      ' containsSemiMixedTypes="0"' +
      (f.blank ? ' containsBlank="1"' : '') +
      '/>'
  } else {
    shared = `<sharedItems${f.blank ? ' containsBlank="1"' : ''}/>`
  }

  return `<cacheField name="${esc(f.name)}" numFmtId="0">${shared}</cacheField>`
}

export function pivotCacheDefinitionXml(plan: PivotPlan, hasRecords: boolean): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' +
    `<pivotCacheDefinition xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"` +
    (hasRecords ? ' r:id="rId1"' : '') +
    ' refreshOnLoad="1" refreshedBy="LD Cotton Mills ERP"' +
    ` recordCount="${hasRecords ? plan.recordCount : 0}"` +
    ' createdVersion="3" refreshedVersion="3" minRefreshableVersion="3">' +
    '<cacheSource type="worksheet">' +
    `<worksheetSource ref="${plan.sourceRef}" sheet="${esc(plan.sourceSheet)}"/>` +
    '</cacheSource>' +
    `<cacheFields count="${plan.fields.length}">` +
    plan.fields.map(cacheFieldXml).join('') +
    '</cacheFields>' +
    '</pivotCacheDefinition>'
  )
}

// ── The cached rows ─────────────────────────────────────────────────────────

export function pivotCacheRecordsXml(plan: PivotPlan): string {
  // One index per shared-item field, built once. An indexOf inside the row
  // loop is O(rows × items), and on ten thousand rows against a few hundred
  // suppliers that lookup is the whole request.
  const lookups = plan.fields.map((f) => (f.items ? new Map(f.items.map((v, i) => [v, i])) : null))

  const out: string[] = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n',
    `<pivotCacheRecords xmlns="${NS_MAIN}" xmlns:r="${NS_REL}" count="${plan.recordCount}">`,
  ]

  for (const rec of plan.records) {
    out.push('<r>')
    for (let i = 0; i < plan.fields.length; i++) {
      const f = plan.fields[i]
      const lookup = lookups[i]
      const v = rec[i]

      if (v == null || v === '') {
        // A blank is an item in its own right on a shared field, and it is
        // the last one — which is what `count` above accounted for.
        out.push(lookup ? `<x v="${f.items!.length}"/>` : '<m/>')
        continue
      }

      if (lookup) {
        const at = lookup.get(String(v))
        out.push(at == null ? `<x v="${f.items!.length}"/>` : `<x v="${at}"/>`)
      } else if (f.kind === 'number') {
        const n = Number(v)
        out.push(Number.isFinite(n) ? `<n v="${num(n)}"/>` : '<m/>')
      } else if (f.kind === 'date' && v instanceof Date) {
        out.push(`<d v="${isoLocal(v)}"/>`)
      } else {
        out.push(`<s v="${esc(String(v))}"/>`)
      }
    }
    out.push('</r>')
  }

  out.push('</pivotCacheRecords>')
  return out.join('')
}

// ── The table ───────────────────────────────────────────────────────────────

function pivotFieldXml(plan: PivotPlan, index: number): string {
  const f = plan.fields[index]
  const isRow = index === plan.rowField
  const isData = plan.dataFields.some((d) => d.field === index)
  const isSlicer = plan.slicerFields.includes(index)

  if (isData) return '<pivotField dataField="1" showAll="0"/>'

  if (isRow || isSlicer) {
    const n = (f.items?.length ?? 0) + (f.blank ? 1 : 0)
    const items =
      `<items count="${n + 1}">` +
      Array.from({ length: n }, (_, i) => `<item x="${i}"/>`).join('') +
      // The default item is the subtotal line. Excel expects it last and
      // counts it, which is why `count` is n + 1 rather than n.
      '<item t="default"/>' +
      '</items>'
    return `<pivotField${isRow ? ' axis="axisRow"' : ''} showAll="0">${items}</pivotField>`
  }

  return '<pivotField showAll="0"/>'
}

export function pivotTableXml(plan: PivotPlan): string {
  const f = plan.fields[plan.rowField]
  const rowCount = (f?.items?.length ?? 0) + (f?.blank ? 1 : 0)
  const many = plan.dataFields.length > 1

  const body =
    `<location ref="${pivotLocationRef(plan)}" firstHeaderRow="1" firstDataRow="2" firstDataCol="1"/>` +
    `<pivotFields count="${plan.fields.length}">` +
    plan.fields.map((_, i) => pivotFieldXml(plan, i)).join('') +
    '</pivotFields>' +
    `<rowFields count="1"><field x="${plan.rowField}"/></rowFields>` +
    `<rowItems count="${rowCount + 1}">` +
    Array.from({ length: rowCount }, (_, i) =>
      i === 0 ? '<i><x/></i>' : `<i><x v="${i}"/></i>`
    ).join('') +
    '<i t="grand"><x/></i>' +
    '</rowItems>' +
    // With more than one measure the data fields themselves become the column
    // axis — that is what `x="-2"` means. With one there is no column axis at
    // all, and a single empty `<i/>` is the whole of it.
    (many
      ? '<colFields count="1"><field x="-2"/></colFields>' +
        `<colItems count="${plan.dataFields.length}">` +
        plan.dataFields
          .map((_, i) => (i === 0 ? '<i><x/></i>' : `<i i="${i}"><x v="${i}"/></i>`))
          .join('') +
        '</colItems>'
      : '<colItems count="1"><i/></colItems>') +
    `<dataFields count="${plan.dataFields.length}">` +
    plan.dataFields
      .map(
        (d) =>
          `<dataField name="${esc(d.label)}" fld="${d.field}" baseField="0" baseItem="0"` +
          ` numFmtId="${d.numFmtId ?? 0}"/>`
      )
      .join('') +
    '</dataFields>' +
    '<pivotTableStyleInfo name="PivotStyleMedium9" showRowHeaders="1" showColHeaders="1"' +
    ' showRowStripes="0" showColStripes="0" showLastColumn="1"/>'

  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' +
    `<pivotTableDefinition xmlns="${NS_MAIN}" name="${esc(plan.tableName)}"` +
    ` cacheId="${plan.cacheId}" applyNumberFormats="0" applyBorderFormats="0"` +
    ' applyFontFormats="0" applyPatternFormats="0" applyAlignmentFormats="0"' +
    ' applyWidthHeightFormats="1" dataCaption="Values" updatedVersion="3"' +
    ' minRefreshableVersion="3" createdVersion="3" indent="0" outline="1"' +
    ' outlineData="1" multipleFieldFilters="0">' +
    body +
    '</pivotTableDefinition>'
  )
}
