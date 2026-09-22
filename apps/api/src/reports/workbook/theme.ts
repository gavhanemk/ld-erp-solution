import type { ColumnType, Kpi } from '../types'

/**
 * How every workbook looks and counts.
 *
 * One place, because six reports that each chose their own rupee format is how
 * two sheets in one pack end up disagreeing about what a lakh looks like.
 */

export const INK = {
  heading: 'FF0F172A',
  body: 'FF334155',
  muted: 'FF64748B',
  onBrand: 'FFFFFFFF',
} as const

export const PAPER = {
  brand: 'FF0F766E',
  brandSoft: 'FFE6F4F1',
  card: 'FFF8FAFC',
  rule: 'FFE2E8F0',
  header: 'FF134E4A',
  good: 'FFDCFCE7',
  warn: 'FFFEF3C7',
  bad: 'FFFEE2E2',
} as const

export const TONE_INK = {
  good: 'FF166534',
  warn: 'FF92400E',
  bad: 'FF991B1B',
} as const

/**
 * Indian digit grouping.
 *
 * Excel has no built-in for it — `#,##0` groups in thousands all the way up,
 * so 1,25,00,000 prints as 12,500,000 and reads as a different number to
 * everyone who will open this. The three-band conditional is the only way to
 * get lakhs and crores out of a number format.
 */
export const FMT = {
  money: '[>=10000000]##\\,##\\,##\\,##0.00;[>=100000]##\\,##\\,##0.00;##,##0.00',
  moneyWhole: '[>=10000000]##\\,##\\,##\\,##0;[>=100000]##\\,##\\,##0;##,##0',
  qty: '#,##0.###',
  integer: '#,##0',
  percent: '0.0%',
  date: 'dd-mmm-yyyy',
  /** Charts plot lakhs, so their axis wants one decimal and no grouping band. */
  lakh: '#,##0.0',
} as const

export function numberFormatFor(type: ColumnType): string | undefined {
  switch (type) {
    case 'money':
      return FMT.money
    case 'qty':
      return FMT.qty
    case 'integer':
      return FMT.integer
    case 'percent':
      return FMT.percent
    case 'date':
      return FMT.date
    default:
      return undefined
  }
}

/**
 * Money on a chart, in lakhs.
 *
 * Excel's own axis scaling only does powers of a thousand, so it cannot
 * produce a lakh or a crore however it is asked. The numbers are divided here
 * and the chart title says so; the exact figures stay on the Data sheet, which
 * is the sheet anybody checking a total will open anyway.
 */
export const LAKH = 100_000

export function toLakh(v: number): number {
  return Math.round((v / LAKH) * 100) / 100
}

/**
 * A KPI as it prints.
 *
 * Null is a dash and never a nought. A nought is a claim that something was
 * measured and came to nothing; a dash says it could not be measured at all,
 * and an empty month reading "₹0 average bill" is the first of those
 * pretending to be the second.
 */
export function kpiText(k: Kpi): string {
  if (k.value == null) return '—'
  switch (k.format) {
    case 'money':
      return `₹${k.value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    case 'percent':
      return `${(k.value * 100).toFixed(1)}%`
    case 'days':
      return `${Math.round(k.value)} ${Math.round(k.value) === 1 ? 'day' : 'days'}`
    case 'qty':
      return `${k.value.toLocaleString('en-IN', { maximumFractionDigits: 3 })}${k.unit ? ` ${k.unit}` : ''}`
    default:
      return k.value.toLocaleString('en-IN')
  }
}
