/**
 * The named date ranges every list and report offers.
 *
 * Extracted from the reports filter bar so the notes screens can offer the
 * same ones. Two copies would have been two definitions of the financial
 * year, and the one that drifted would have been wrong in a way nobody
 * questions until somebody files a return against it.
 */

const pad = (n: number) => String(n).padStart(2, '0')

/** A date as `2026-09-23`, which is what a date input reads and writes. */
export const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

/**
 * India's financial year runs April to March, so "this year" in a mill office
 * is not the calendar one. A preset labelled FY handing back January to
 * December would be wrong in a way nobody questions until filing.
 */
export function fyStart(d: Date): Date {
  return new Date(d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1, 3, 1)
}

export interface Preset {
  label: string
  from: Date
  to: Date
}

export function presets(): Preset[] {
  const now = new Date()
  const y = now.getFullYear()
  const m = now.getMonth()
  const fy = fyStart(now)
  // Quarters are counted off April too, for the same reason.
  const q = Math.floor(((m - 3 + 12) % 12) / 3)

  return [
    { label: 'This month', from: new Date(y, m, 1), to: now },
    { label: 'Last month', from: new Date(y, m - 1, 1), to: new Date(y, m, 0) },
    { label: 'This quarter', from: new Date(fy.getFullYear(), 3 + q * 3, 1), to: now },
    { label: 'This FY', from: fy, to: now },
    {
      label: 'Last FY',
      from: new Date(fy.getFullYear() - 1, 3, 1),
      to: new Date(fy.getFullYear(), 2, 31),
    },
  ]
}

/** Which named period a pair of dates is, if it is one. */
export function presetFor(from: string, to: string): string {
  return presets().find((p) => from === ymd(p.from) && to === ymd(p.to))?.label ?? ''
}
