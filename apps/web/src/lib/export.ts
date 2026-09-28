import { api, type Paginated } from '@/lib/api'

/**
 * Taking a list off the screen and into a spreadsheet.
 *
 * Shared by the four purchase lists, because four screens that each grew
 * their own exporter would disagree within a month about quoting, about what
 * a blank cell means, and about whether a rupee figure arrives as a number or
 * as the text "₹19,800.00" — and only one of those can be summed.
 */

/**
 * One cell's worth of data.
 *
 * A number stays a number and a date stays a date all the way into the file,
 * so a column of totals can be summed and a column of dates can be sorted.
 * Formatting them into text here is the single mistake that makes an export
 * useless for the thing people export for.
 */
export type Cell = string | number | Date | null | undefined

export interface ExportColumn<T> {
  header: string
  value: (row: T) => Cell
}

export type ExportFormat = 'csv' | 'xlsx'

/** Local yyyy-mm-dd. `toISOString` would shift an Indian date back a day. */
function ymd(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** An ISO timestamp from the API as a Date, or null if there wasn't one. */
export function asDate(iso?: string | null): Date | null {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d
}

/** A Prisma decimal arrives as a string. Make it a number the sheet can add up. */
export function asNumber(v?: string | number | null): number | null {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isNaN(n) ? null : n
}

function csvCell(v: Cell): string {
  if (v == null) return ''
  if (v instanceof Date) return ymd(v)
  const s = String(v)
  // Quote anything holding a comma, a quote or a line break — a supplier
  // called "Shah & Co, Unit 2" would otherwise become two columns.
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function toCsv<T>(rows: T[], columns: ExportColumn<T>[]): string {
  const lines = [
    columns.map((c) => csvCell(c.header)).join(','),
    ...rows.map((r) => columns.map((c) => csvCell(c.value(r))).join(',')),
  ]
  // CRLF, per RFC 4180 and what Excel on Windows expects.
  return lines.join('\r\n')
}

function save(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Freed on a delay: revoking it in the same tick cancels the download in
  // some browsers before it has read the blob.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Wide enough for the longest thing in the column, within reason. */
function widths<T>(rows: T[], columns: ExportColumn<T>[]) {
  return columns.map((c, i) => {
    let widest = c.header.length
    for (const r of rows) {
      const v = c.value(r)
      const len = v instanceof Date ? 10 : v == null ? 0 : String(v).length
      if (len > widest) widest = len
    }
    return { wch: Math.min(45, Math.max(8, widest + 2)), key: i }
  })
}

/**
 * Excel counts days from 30 December 1899 — a date that never existed, chosen
 * to absorb Lotus 1-2-3's belief that 1900 was a leap year.
 */
const EXCEL_EPOCH = Date.UTC(1899, 11, 30)

/**
 * One value as a spreadsheet cell.
 *
 * Dates are written as their day number rather than handed over as a `Date`.
 * SheetJS 0.18 converts a Date through the browser's timezone and lands ten
 * seconds past midnight — 46287.00011574 instead of 46287. It *displays* as
 * the right date, so it looks fine, and then `COUNTIF(range, DATE(2026,9,22))`
 * silently matches nothing because the two numbers are not equal. Computing
 * the day number here gives a whole number every time, checked against a leap
 * day and against the 1900 quirk.
 */
function sheetCell(v: Cell): unknown {
  if (v == null) return ''
  if (v instanceof Date) {
    const day = Math.round(
      (Date.UTC(v.getFullYear(), v.getMonth(), v.getDate()) - EXCEL_EPOCH) / 86_400_000
    )
    return { t: 'n', v: day, z: 'dd-mm-yyyy' }
  }
  return v
}

/**
 * Writes the rows to a file and hands it to the browser.
 *
 * SheetJS is pulled in only when somebody actually exports. It is about a
 * megabyte, and four list screens that all load it up front would pay for it
 * on every visit for a thing most visits never do.
 */
export async function downloadRows<T>({
  rows,
  columns,
  name,
  sheet = 'Sheet1',
  format,
}: {
  rows: T[]
  columns: ExportColumn<T>[]
  /** Without a date or an extension — both are added. */
  name: string
  sheet?: string
  format: ExportFormat
}): Promise<void> {
  const stamp = ymd(new Date())
  const filename = `${name}-${stamp}.${format}`

  if (format === 'csv') {
    // The BOM is what tells Excel the file is UTF-8. Without it ₹ and any
    // supplier name outside plain ASCII open as mojibake on a Windows desk.
    const blob = new Blob(['﻿' + toCsv(rows, columns)], {
      type: 'text/csv;charset=utf-8',
    })
    save(blob, filename)
    return
  }

  const XLSX = await import('xlsx')
  const aoa = [
    columns.map((c) => c.header as unknown),
    ...rows.map((r) => columns.map((c) => sheetCell(c.value(r)))),
  ]
  const ws = XLSX.utils.aoa_to_sheet(aoa)
  ws['!cols'] = widths(rows, columns)
  // Freezes the header row, so scrolling three hundred orders does not lose
  // the names of the columns.
  ws['!freeze'] = { xSplit: '0', ySplit: '1', topLeftCell: 'A2', activePane: 'bottomLeft' }
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, sheet.slice(0, 31))
  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' })
  save(
    new Blob([out], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }),
    filename
  )
}

/**
 * Every page of a paginated list, not just the one being looked at.
 *
 * The three paginated purchase lists cap a request at 100 or 200 rows, so an
 * export that asked once would quietly stop at the first page — and a partial
 * spreadsheet that does not say it is partial is worse than no export at all.
 *
 * `cap` is a backstop against a runaway loop, not a business rule. When it
 * bites, the caller is told how many rows were left behind so it can say so.
 */
export async function fetchEveryPage<T>(
  url: (page: number) => string,
  cap = 10_000
): Promise<{ rows: T[]; total: number; truncated: boolean }> {
  const first = await api.get<Paginated<T>>(url(1))
  const rows = [...first.data]
  const total = first.pagination.total
  const pages = first.pagination.pages

  for (let p = 2; p <= pages && rows.length < cap; p++) {
    const next = await api.get<Paginated<T>>(url(p))
    rows.push(...next.data)
  }

  return { rows: rows.slice(0, cap), total, truncated: rows.length > cap || total > cap }
}
