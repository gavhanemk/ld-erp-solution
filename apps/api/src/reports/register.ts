import type { ReportColumn, ReportDefinition, RegisterSpec } from './types'

/**
 * The totals of a register, worked out once.
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

/** "LD Cotton Mills", then its address and GSTIN, as the letterhead prints them. */
export function letterhead(c: RegisterCompany | null): { name: string; lines: string[] } {
  if (!c) return { name: '', lines: [] }
  const place = [c.address, c.city, [c.state, c.pincode].filter(Boolean).join(' - ')]
    .filter(Boolean)
    .join(', ')
  const reach = [c.gstin && `GSTIN: ${c.gstin}`, c.phone && `Phone: ${c.phone}`, c.email]
    .filter(Boolean)
    .join('   ')
  return { name: c.legalName || c.name, lines: [place, reach].filter(Boolean) }
}

export interface RegisterTotals {
  /** One per month — empty when everything falls in a single month. */
  months: RegisterTotal[]
  grand: RegisterTotal
}

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
  lastRow: number,
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

  const isVoid = (r: Record<string, unknown>) =>
    spec.void != null && r[spec.void.key] === spec.void.value
  const counted = new Set<unknown>()
  const voided = new Set<unknown>()
  for (const r of rows) (isVoid(r) ? voided : counted).add(r[spec.documentKey])

  const counts = { documents: counted.size, voided: voided.size }
  return { label, ...counts, count: countWords(counts, spec), sums, byUnit, lastRow }
}

export function registerTotals(
  def: ReportDefinition,
  rows: Array<Record<string, unknown>>
): RegisterTotals {
  const spec = def.register
  if (!spec) throw new Error(`${def.id} is not a register`)

  const months: RegisterTotal[] = []
  let start = 0
  const monthOf = (r: Record<string, unknown>) => {
    const d = r[spec.monthKey]
    return d instanceof Date ? istDay(d).slice(0, 7) : ''
  }
  for (let i = 1; i <= rows.length; i++) {
    if (i === rows.length || monthOf(rows[i]) !== monthOf(rows[start])) {
      const key = monthOf(rows[start])
      months.push(
        totalOf(key ? monthLabel(key) : 'Undated', rows.slice(start, i), i - 1, def.columns, spec)
      )
      start = i
    }
  }

  return {
    // A single month's subtotal would only repeat the grand total under it.
    months: months.length > 1 ? months : [],
    grand: totalOf('Grand total', rows, rows.length - 1, def.columns, spec),
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
