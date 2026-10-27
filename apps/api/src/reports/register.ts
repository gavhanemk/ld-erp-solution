import type { RegisterColumn, ReportColumn, ReportDefinition, RegisterSpec } from './types'

/**
 * Every report as a register: its layout worked out, and its totals worked
 * out once.
 *
 * The screen, the printed sheet and the workbook all print these figures
 * rather than adding the columns up themselves. Three sums of the same column
 * are three chances to disagree by a paisa, and a register whose PDF and
 * spreadsheet differ is one nobody can file.
 */

/** A quantity added up within one unit — never across two. */
export interface UnitTotal {
  unit: string
  value: number
}

export interface RegisterTotal {
  /** "April 2026", or "Grand total". */
  label: string
  /** Documents counted. A void one is listed but not counted. */
  documents: number
  /** Void documents in the same span. */
  voided: number
  /** The two counts in words: "23 bills", "23 bills · 1 cancelled". */
  count: string
  /** Money, and quantities in a single fixed unit, by column key. */
  sums: Record<string, number>
  /** Quantities whose unit varies by row, unit by unit, by column key. */
  byUnit: Record<string, UnitTotal[]>
  /**
   * The index of the last row this total covers, so a subtotal can be printed
   * straight after it. Rows arrive sorted by date, so a month's rows are one
   * unbroken run.
   */
  lastRow: number
}

/** The letterhead a register prints under. */
export interface RegisterCompany {
  name: string
  legalName: string | null
  address: string | null
  city: string | null
  state: string | null
  pincode: string | null
  gstin: string | null
  phone: string | null
  email: string | null
}

export const COMPANY_SELECT = {
  name: true,
  legalName: true,
  address: true,
  city: true,
  state: true,
  pincode: true,
  gstin: true,
  phone: true,
  email: true,
} as const

/**
 * "LD Cotton Mills", then its address and GSTIN, as the letterhead prints them.
 *
 * The mill's own name, as Settings holds it, rather than the legal name the
 * documents it sends out carry: a register is the mill's working paper, and
 * the accounts team asked for it to read "LD Cotton Mills" and nothing more.
 */
export function letterhead(c: RegisterCompany | null): { name: string; lines: string[] } {
  if (!c) return { name: '', lines: [] }
  const place = [c.address, c.city, [c.state, c.pincode].filter(Boolean).join(' - ')]
    .filter(Boolean)
    .join(', ')
  const reach = [c.gstin && `GSTIN: ${c.gstin}`, c.phone && `Phone: ${c.phone}`, c.email]
    .filter(Boolean)
    .join('   ')
  return { name: c.name || c.legalName || '', lines: [place, reach].filter(Boolean) }
}

export interface RegisterTotals {
  /** One per month — empty when everything falls in a single month. */
  months: RegisterTotal[]
  grand: RegisterTotal
}

// ── The layout ──────────────────────────────────────────────────────────────

/** The columns a report keeps its unit of measure in. */
const UNIT_COLUMNS = new Set(['uom', 'unit', 'uqc'])

/**
 * The report's columns, with every quantity told where its unit is.
 *
 * Most reports keep the unit in a `uom` column beside the figures. Pointing
 * each quantity at it is what lets a total add metres to metres and pieces to
 * pieces, and never one to the other.
 */
export function resolveColumns(def: ReportDefinition): ReportColumn[] {
  const unit = def.columns.find((c) => UNIT_COLUMNS.has(c.key) && c.type === 'text')?.key
  return def.columns.map((c) =>
    c.type === 'qty' && !c.unit && !c.unitKey && unit ? { ...c, unitKey: unit } : c
  )
}

/**
 * A single code or number, which never breaks across lines. A name or a list
 * of numbers may.
 */
const CODE =
  /(Number|No|Code|Challan|Po)$|^(gstin|jwGstin|pan|hsn|uom|unit|uqc|lossUqc|month|document|invoice|number|eWayBill|bucket|section|style)$/

/** The columns that carry a party's or an item's name, given room before they wrap. */
const NAMES = new Set(['item', 'supplier', 'customer', 'jobWorker', 'description'])

/**
 * What prints, when a report does not say: every column, in order, with an
 * item's code set under its name, and the unit of one or two quantities
 * printed in the figure ("2,316.00 mtr") instead of in a column of its own.
 * Past two quantities a Unit column is the narrower of the two.
 */
function printFor(columns: ReportColumn[]): RegisterColumn[] {
  const keys = new Set(columns.map((c) => c.key))
  const withUnit = columns.filter((c) => c.type === 'qty' && c.unitKey)
  const unitKey = withUnit[0]?.unitKey
  const inline =
    unitKey != null && withUnit.length <= 2 && withUnit.every((c) => c.unitKey === unitKey)

  const out: RegisterColumn[] = []
  for (const c of columns) {
    if (inline && c.key === unitKey) continue
    if (c.key === 'itemCode' && keys.has('item')) continue
    if (c.key === 'item' && keys.has('itemCode')) {
      out.push({ key: 'item', sub: ['itemCode'], subLabel: 'Code', wrap: true, wide: true })
      continue
    }
    const words = c.type === 'text' && !CODE.test(c.key)
    out.push({ key: c.key, ...(words ? { wrap: true, ...(NAMES.has(c.key) ? { wide: true } : {}) } : {}) })
  }
  return out
}

/** A report's register with every default filled in. */
export function resolveRegister(def: ReportDefinition, columns = resolveColumns(def)): RegisterSpec {
  const o = def.register ?? {}
  const all = columns.map((c) => c.key)
  const documentKey = o.documentKey ?? ''
  const documentColumns = new Set(o.documentColumns ?? [documentKey])
  const first = columns[0]
  return {
    documentKey,
    noun: o.noun ?? { one: 'entry', many: 'entries' },
    lineKeys: !documentKey ? all : (o.lineKeys ?? all.filter((k) => !documentColumns.has(k))),
    print: o.print ?? printFor(columns),
    noteKey: o.noteKey,
    void: o.void,
    monthKey:
      o.monthKey === false ? '' : (o.monthKey ?? (first?.type === 'date' ? first.key : '')),
  }
}

// ── The totals ──────────────────────────────────────────────────────────────

const round2 = (n: number) => Math.round(n * 100) / 100
const round3 = (n: number) => Math.round(n * 1000) / 1000

/**
 * The calendar day a date falls on in India, as yyyy-mm-dd.
 *
 * A bill picked for "1 April" is stored at midnight UTC, and one booked with
 * no date picked carries the moment it was saved. Read in the server's own
 * zone — UTC on the host — a bill saved at 1:30 in the morning of 1 May would
 * land in April. Every register date is read here, in India's time, so the
 * month it is subtotalled under is the month printed beside it.
 */
export function istDay(d: Date): string {
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
}

/** A date however a report holds it — a Date, or text a Date can read. */
export function asDate(v: unknown): Date | null {
  const d = v instanceof Date ? v : typeof v === 'string' && v ? new Date(v) : null
  return d && !Number.isNaN(d.getTime()) ? d : null
}

const MONTH = new Intl.DateTimeFormat('en-IN', {
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
})

function monthLabel(yyyyMm: string): string {
  const [y, m] = yyyyMm.split('-').map(Number)
  return MONTH.format(new Date(Date.UTC(y, m - 1, 1)))
}

function isNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function totalOf(
  label: string,
  rows: Array<Record<string, unknown>>,
  offset: number,
  columns: ReportColumn[],
  spec: RegisterSpec
): RegisterTotal {
  const summed = columns.filter((c) => c.total === 'sum')
  const sums: Record<string, number> = {}
  const byUnit: Record<string, UnitTotal[]> = {}

  for (const c of summed) {
    if (c.type === 'qty' && c.unitKey) {
      const units = new Map<string, number>()
      for (const r of rows) {
        const v = r[c.key]
        if (!isNumber(v)) continue
        const unit = String(r[c.unitKey] ?? '') || 'units'
        units.set(unit, (units.get(unit) ?? 0) + v)
      }
      byUnit[c.key] = [...units.entries()]
        .map(([unit, value]) => ({ unit, value: round3(value) }))
        .sort((a, b) => a.unit.localeCompare(b.unit))
    } else {
      const total = rows.reduce((s, r) => s + (isNumber(r[c.key]) ? (r[c.key] as number) : 0), 0)
      sums[c.key] = c.type === 'qty' ? round3(total) : round2(total)
    }
  }

  // Without a document key every row is its own document.
  const isVoid = (r: Record<string, unknown>) =>
    spec.void != null && r[spec.void.key] === spec.void.value
  const counted = new Set<unknown>()
  const voided = new Set<unknown>()
  rows.forEach((r, i) =>
    (isVoid(r) ? voided : counted).add(spec.documentKey ? r[spec.documentKey] : offset + i)
  )

  const counts = { documents: counted.size, voided: voided.size }
  return {
    label,
    ...counts,
    count: countWords(counts, spec),
    sums,
    byUnit,
    lastRow: offset + rows.length - 1,
  }
}

export function registerTotals(
  def: ReportDefinition,
  rows: Array<Record<string, unknown>>,
  columns = resolveColumns(def),
  spec = resolveRegister(def, columns)
): RegisterTotals {
  const months: RegisterTotal[] = []
  if (spec.monthKey) {
    const monthOf = (r: Record<string, unknown>) => {
      const d = asDate(r[spec.monthKey])
      return d ? istDay(d).slice(0, 7) : ''
    }
    let start = 0
    for (let i = 1; i <= rows.length; i++) {
      if (i === rows.length || monthOf(rows[i]) !== monthOf(rows[start])) {
        const key = monthOf(rows[start])
        months.push(
          totalOf(key ? monthLabel(key) : 'Undated', rows.slice(start, i), start, columns, spec)
        )
        start = i
      }
    }
  }
  // A report not in date order would come back as April, May, April again: a
  // month total is only printed when each month is one unbroken run.
  const inOrder = new Set(months.map((m) => m.label)).size === months.length

  return {
    // A single month's subtotal would only repeat the grand total under it.
    months: months.length > 1 && inOrder ? months : [],
    grand: totalOf('Grand total', rows, 0, columns, spec),
  }
}

/** "47 bills", "47 bills · 1 cancelled", in the register's own words. */
export function countWords(
  t: { documents: number; voided: number },
  spec: RegisterSpec
): string {
  const { one, many } = spec.noun
  const n = `${t.documents.toLocaleString('en-IN')} ${t.documents === 1 ? one : many}`
  return t.voided && spec.void ? `${n} · ${t.voided} ${spec.void.word}` : n
}
